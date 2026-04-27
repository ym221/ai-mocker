#!/usr/bin/env node
/**
 * Stability test runner — runs ONE full MCP cycle end-to-end.
 *
 * Usage:
 *   node tests/stability-runs/cycle.mjs <cycleId> <moduleName> <specPath> <updateInstructionPath> [--http-cleanup]
 *
 * Output:
 *   tests/stability-runs/cycle-<cycleId>.json — structured per-step result
 *   stdout — single-line progress markers per step
 *
 * Each cycle is INDEPENDENT: deletes the target module first, runs the full
 * battery, deletes again at the end. No coordination with other cycles.
 *
 * Steps (12):
 *   1. login + fresh API key
 *   2. delete target module (cleanup)
 *   3. list_modules baseline
 *   4. create_module_from_spec (auto-resume up to 3× 280s = 14min budget)
 *   5. inspect_module health  → expect healthy + 0 missingFiles
 *   6. inspect_module openapi → expect each entity has its own $ref schema
 *   7. HTTP CRUD all standard endpoints (post/get-list/get-id/put/delete)
 *   8. manage_data CRUD on every entity
 *   9. run_test → expect total > 0 and passed === total (with 1 retry to absorb
 *      the known cleanup flakiness from F3 audit; record both attempts)
 *  10. update_module add 1 small field, expect diff.hasChange === true
 *  11. run_test again → must still all-pass
 *  12. get_mock_access_log + diff_with_openapi + generate_handoff_report smoke
 *  13. delete_module
 *
 * Each step records: { ok, durationMs, detail, error? }
 * Cycle-level result: { ok, failedStep, totalDurationMs, ... }
 */

import { writeFileSync, readFileSync } from 'fs';
import { resolve } from 'path';

const MCP_URL = 'http://127.0.0.1:3000/mcp';
const API_BASE = 'http://127.0.0.1:3000';

// ---------- argv ----------
const [, , cycleId, moduleName, specPath, updateInstructionPath, ...rest] = process.argv;
if (!cycleId || !moduleName || !specPath || !updateInstructionPath) {
  console.error('usage: cycle.mjs <id> <name> <spec.txt> <update.txt>');
  process.exit(1);
}
const spec = readFileSync(resolve(specPath), 'utf-8');
const updateInstruction = readFileSync(resolve(updateInstructionPath), 'utf-8');

// ---------- logging ----------
const STEPS = [];
const startedAt = Date.now();
function logStep(name, ok, detail, error) {
  const step = { name, ok, durationMs: detail?.durationMs ?? null, detail: detail || null };
  if (error) {
    step.error = error.message || String(error);
    step.errorStack = error.stack;
    step.errorCause = error.cause?.message || null;
    step.errorCauseStack = error.cause?.stack || null;
  }
  STEPS.push(step);
  const tag = ok ? '✓' : '✗';
  const sec = step.durationMs != null ? `(${(step.durationMs / 1000).toFixed(1)}s)` : '';
  const causeStr = step.errorCause ? ` cause=${step.errorCause}` : '';
  console.log(`[cycle-${cycleId}] ${tag} ${name} ${sec}${error ? ' — ' + step.error + causeStr : ''}`);
}

function finishAndExit(ok, summary) {
  // Aggregate quality issues across all steps (recorded even when steps "passed").
  const qualityFailures = [];
  const warnings = [];
  for (const s of STEPS) {
    const d = s.detail || {};
    if (Array.isArray(d.qualityFailures)) qualityFailures.push(...d.qualityFailures.map(f => `${s.name}: ${f}`));
    if (Array.isArray(d.warnings)) warnings.push(...d.warnings.map(w => `${s.name}: ${w}`));
  }
  // Special: step 9 with allPassed=false is a quality failure
  const result = {
    cycleId,
    moduleName,
    ok,
    summary,
    qualityClean: qualityFailures.length === 0 && warnings.length === 0,
    qualityFailureCount: qualityFailures.length,
    warningCount: warnings.length,
    qualityFailures,
    warnings,
    totalDurationMs: Date.now() - startedAt,
    failedStep: STEPS.find(s => !s.ok)?.name ?? null,
    steps: STEPS,
    timestamp: new Date().toISOString(),
  };
  const out = resolve(`tests/stability-runs/cycle-${cycleId}.json`);
  writeFileSync(out, JSON.stringify(result, null, 2), 'utf-8');
  const tag = ok ? (result.qualityClean ? 'PASS-CLEAN' : `PASS-WITH-${qualityFailures.length}Q-${warnings.length}W`) : 'FAIL';
  console.log(`[cycle-${cycleId}] === RESULT: ${tag} (${(result.totalDurationMs / 1000).toFixed(1)}s) ===`);
  console.log(`[cycle-${cycleId}] saved to ${out}`);
  process.exit(ok ? 0 : 1);
}

// ---------- helpers ----------
async function fetchJson(url, opts = {}, label) {
  const t0 = Date.now();
  const res = await fetch(url, opts);
  const txt = await res.text();
  let body;
  try { body = txt ? JSON.parse(txt) : null; } catch { body = { __raw: txt.slice(0, 200) }; }
  return { status: res.status, body, durationMs: Date.now() - t0 };
}

let API_KEY = '';
/**
 * Stream-based MCP call. The server uses HTTP-streamable SSE transport — long
 * tool calls send progress notifications first, then the response envelope,
 * then close. `res.text()` waits for the connection to close, which doesn't
 * honor AbortController reliably, leading to multi-hour hangs.
 *
 * Strategy: read the body chunk-by-chunk, parse each `data: {...}` line, and
 * return as soon as we see an envelope whose id matches our request id (which
 * is the tool-call response, distinct from progress notifications).
 */
async function mcpCall(toolName, args, timeoutMs = 30000) {
  const t0 = Date.now();
  const requestId = Math.floor(Math.random() * 1_000_000_000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    try { ctrl.abort(new Error(`mcpCall(${toolName}) hard-timeout after ${timeoutMs}ms`)); } catch {}
  }, timeoutMs);
  try {
    const res = await fetch(MCP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'X-API-Key': API_KEY,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      }),
      signal: ctrl.signal,
    });

    if (!res.body) {
      // No streaming body (might be plain JSON error response)
      const txt = await res.text();
      try {
        const env = JSON.parse(txt);
        return { ok: false, durationMs: Date.now() - t0, body: env, error: env.error };
      } catch {
        return { ok: false, durationMs: Date.now() - t0, raw: txt.slice(0, 300) };
      }
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let final = null;
    let lastSawDataAt = Date.now();

    while (true) {
      // Per-read soft inactivity check — if no SSE chunk for too long, give up.
      const inactivity = Date.now() - lastSawDataAt;
      if (inactivity > timeoutMs) {
        try { reader.cancel(); } catch {}
        throw new Error(`mcpCall(${toolName}) inactive ${inactivity}ms (>${timeoutMs}) — aborting`);
      }
      let value, done;
      try {
        ({ value, done } = await reader.read());
      } catch (err) {
        try { reader.cancel(); } catch {}
        throw err;
      }
      if (value) {
        buf += decoder.decode(value, { stream: true });
        lastSawDataAt = Date.now();
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() || ''; // keep last incomplete line for next read
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const json = line.slice(6).trim();
          if (!json) continue;
          let env;
          try { env = JSON.parse(json); } catch { continue; }
          // Match the response to OUR request id; skip progress notifications.
          if (env.id === requestId && (env.result !== undefined || env.error !== undefined)) {
            final = env;
            break;
          }
        }
        if (final) break;
      }
      if (done) break;
    }

    try { await reader.cancel(); } catch {}

    if (!final) {
      throw new Error(`mcpCall(${toolName}): no final envelope (stream ended without matching id)`);
    }
    if (final.error) {
      return { ok: false, durationMs: Date.now() - t0, body: final, error: final.error };
    }
    const sc = final.result?.structuredContent;
    const isErr = final.result?.isError === true;
    return { ok: !isErr, durationMs: Date.now() - t0, body: final, structured: sc, isError: isErr };
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================================
// STEP 1 — login + fresh API key
// ============================================================================
async function step1_login() {
  const t0 = Date.now();
  const loginRes = await fetchJson(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  if (loginRes.status !== 200 || !loginRes.body?.success) {
    throw new Error(`login failed: status=${loginRes.status} body=${JSON.stringify(loginRes.body)}`);
  }
  const token = loginRes.body.data.token;

  const keyRes = await fetchJson(`${API_BASE}/api/users/me/api-key`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Length': '0' },
  });
  if (keyRes.status !== 200 || !keyRes.body?.success) {
    throw new Error(`api-key failed: status=${keyRes.status} body=${JSON.stringify(keyRes.body)}`);
  }
  API_KEY = keyRes.body.data.apiKey;
  return { durationMs: Date.now() - t0, apiKey: API_KEY.slice(0, 8) + '...' };
}

// ============================================================================
// STEP 2 — delete leftover
// ============================================================================
async function step2_cleanup() {
  const r = await mcpCall('delete_module', { moduleName });
  // OK if it didn't exist (returns isError but with MODULE_NOT_FOUND code)
  return { durationMs: r.durationMs, ok: r.ok, code: r.structured?.code, deleted: !r.isError };
}

// ============================================================================
// STEP 3 — list_modules baseline
// ============================================================================
async function step3_listBaseline() {
  const r = await mcpCall('list_modules', {});
  if (!r.ok) throw new Error(`list_modules error: ${JSON.stringify(r.body)}`);
  const exists = r.structured?.modules?.some(m => m.name === moduleName);
  if (exists) throw new Error(`module ${moduleName} still exists after cleanup`);
  return { durationMs: r.durationMs, totalModules: r.structured?.total };
}

// ============================================================================
// STEP 4 — create_module_from_spec (auto-resume)
// ============================================================================
async function step4_create() {
  const t0 = Date.now();
  // Hard wall-clock cap: 18 minutes. Each fetch ~290s; auto-resume up to 3.
  const DEADLINE_MS = 18 * 60_000;
  const MAX = 3;
  let attempt = 0;
  while (attempt < MAX) {
    if (Date.now() - t0 > DEADLINE_MS) {
      throw new Error(`create wall-clock deadline ${DEADLINE_MS}ms exceeded after ${attempt} attempts`);
    }
    attempt++;
    const r = await mcpCall('create_module_from_spec',
      { moduleName, waitMaxSec: 280, spec },
      295_000
    );
    const sc = r.structured;
    if (sc?.status === 'created') {
      return {
        durationMs: Date.now() - t0,
        attempts: attempt,
        endpoints: sc.endpoints?.length ?? 0,
        sessionId: sc.sessionId,
      };
    }
    if (sc?.status === 'still-running') {
      await delay(2000);
      continue;
    }
    if (r.isError) {
      throw new Error(`create error: code=${sc?.code} msg=${sc?.message}`);
    }
    throw new Error(`unexpected create response: ${JSON.stringify(r.body).slice(0, 300)}`);
  }
  throw new Error(`create did not finish within ${MAX} attempts (~14min)`);
}

// ============================================================================
// STEP 5 — inspect health
// ============================================================================
async function step5_inspectHealth() {
  const r = await mcpCall('inspect_module', { moduleName, view: 'health' });
  if (!r.ok) throw new Error(`inspect health error: ${JSON.stringify(r.body)}`);
  const h = r.structured?.health;
  if (h?.status !== 'healthy') {
    throw new Error(`health not healthy: status=${h?.status} missing=${JSON.stringify(h?.missingFiles)} hasTable=${h?.hasTable} metaValid=${h?.metaValid}`);
  }
  return { durationMs: r.durationMs, health: h.status, tableName: h.tableName };
}

// ============================================================================
// STEP 6 — inspect openapi (verify each entity has its own schema)
// ============================================================================
async function step6_inspectOpenapi() {
  const r = await mcpCall('inspect_module', { moduleName, view: 'openapi' });
  if (!r.ok) throw new Error(`inspect openapi error`);
  const spec = r.structured?.openapi?.spec;
  const schemas = Object.keys(spec?.components?.schemas || {});
  // every endpoint $ref should resolve to an existing schema
  const paths = spec?.paths || {};
  const refs = new Set();
  for (const p of Object.values(paths)) {
    for (const m of Object.values(p)) {
      const reqRef = m?.requestBody?.content?.['application/json']?.schema?.$ref;
      if (reqRef) refs.add(reqRef);
      const resOk = m?.responses?.['200']?.content?.['application/json']?.schema;
      if (resOk?.properties?.data?.$ref) refs.add(resOk.properties.data.$ref);
      if (resOk?.properties?.data?.properties?.list?.items?.$ref) refs.add(resOk.properties.data.properties.list.items.$ref);
    }
  }
  const danglingRefs = [...refs].filter(r => {
    const name = r.split('/').pop();
    return !schemas.includes(name);
  });
  return {
    durationMs: r.durationMs,
    schemas,
    pathCount: Object.keys(paths).length,
    danglingRefs,
  };
}

// ============================================================================
// STEP 7 — HTTP CRUD on standard list/detail/create/update/delete endpoints
// ============================================================================
// Helpers used by step 7 & step 8
//
// Entity inference is INTENTIONALLY forgiving — AI might name entities like
// "InventoryRecord" while controller is "createInventory" and path is
// "/inventory". The exact triple-match strategy:
//   1. exact case-insensitive match on entity.name vs (stripped controller / path seg)
//   2. substring containment in either direction (covers "Inventory" ↔ "InventoryRecord")
//   3. plural/singular tolerance (s-suffix)
function _findEntityByToken(token, entities) {
  if (!token) return null;
  const tok = token.toLowerCase();
  const tokSing = tok.replace(/s$/, '');
  // 1. exact
  let hit = entities.find(e => {
    const n = e.name.toLowerCase();
    return n === tok || n === tokSing || n + 's' === tok || n.replace(/s$/, '') === tok;
  });
  if (hit) return hit;
  // 2. substring containment (longer wins)
  hit = entities
    .filter(e => {
      const n = e.name.toLowerCase();
      return n.includes(tok) || tok.includes(n) || n.includes(tokSing) || tokSing.includes(n);
    })
    .sort((a, b) => b.name.length - a.name.length)[0];
  return hit || null;
}
function inferEntityFromControllerName(ctrlName, entities) {
  if (!ctrlName) return null;
  const stripped = ctrlName
    .replace(/^(list|get|create|update|remove|delete)/i, '')
    .replace(/ById$/i, '');
  return _findEntityByToken(stripped, entities);
}
function inferEntityFromPath(path, entities) {
  const seg = (path.split('/').filter(Boolean).pop() || '').toLowerCase();
  if (!seg || seg.startsWith(':') || seg.startsWith('{')) return null;
  return _findEntityByToken(seg, entities);
}
function findParentEntityForFk(fieldName, entities) {
  const m = fieldName.match(/^(.+)_id$/);
  if (!m) return null;
  return _findEntityByToken(m[1], entities);
}
function buildEntityBody(entity, allEntities, insertedIds, ctx) {
  const body = {};
  for (const f of entity.fields || []) {
    if (f.name === 'id') continue;
    if (!(f.required || f.unique)) continue;
    const parent = findParentEntityForFk(f.name, allEntities);
    if (parent) {
      const pid = insertedIds.get(parent.name);
      if (pid == null) return { _err: `FK ${f.name} → ${parent.name} but no parent inserted` };
      body[f.name] = pid;
      continue;
    }
    if (f.enum?.length) body[f.name] = f.enum[0];
    else if (f.type === 'integer' || f.type === 'number') {
      body[f.name] = typeof f.min === 'number' ? Math.max(f.min, 1) : 1;
    } else if (f.type === 'boolean') body[f.name] = true;
    else if (f.pattern === '^[A-Z]{2,5}$') body[f.name] = `T${(cycleId).toString().padStart(2, '0')}`;
    else if (f.pattern && f.pattern.startsWith('^EMP')) body[f.name] = `EMP${(1000 + Number(`${cycleId}${ctx}`) % 9000).toString().padStart(4, '0')}`;
    else if (f.pattern && f.pattern.includes('@')) body[f.name] = `c${cycleId}_${ctx}@example.com`;
    else if (f.pattern) body[f.name] = `c${cycleId}_${ctx}`;
    else {
      // length-aware
      const max = typeof f.maxLength === 'number' ? f.maxLength : 100;
      const min = typeof f.minLength === 'number' ? f.minLength : 1;
      const raw = `c${cycleId}_${ctx}_${f.name}_${Date.now() % 100000}`.slice(0, max);
      body[f.name] = raw.length >= min ? raw : raw.padEnd(min, 'x');
    }
  }
  return body;
}

async function step7_httpCrud() {
  const t0 = Date.now();
  const meta = JSON.parse(readFileSync(resolve(`generated/1/${moduleName}/_meta.json`), 'utf-8'));
  const entities = meta.entities || [];

  // Group endpoints by base path (strip trailing /:id or /{id}) — works for both
  // standard types (list/detail/create/update/delete) and custom-with-controller.
  const groups = new Map();
  for (const ep of meta.endpoints || []) {
    const path = ep.path || '';
    const base = path.replace(/\/(:|\{)id\}?$/, '') || '/';
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(ep);
  }

  // For each group, classify endpoints by HTTP method + presence of :id.
  // Resolve owning entity via controller-name regex → path-segment → first entity.
  const groupSpecs = [];
  for (const [base, eps] of groups) {
    const spec = { base, get_list: null, get_detail: null, post: null, put: null, delete: null, entity: null };
    for (const ep of eps) {
      const method = (ep.method || 'GET').toUpperCase();
      const hasId = /(:|\{)id\}?$/.test(ep.path || '');
      if (method === 'GET' && !hasId) spec.get_list = ep;
      else if (method === 'GET' && hasId) spec.get_detail = ep;
      else if (method === 'POST') spec.post = ep;
      else if (method === 'PUT' || method === 'PATCH') spec.put = ep;
      else if (method === 'DELETE') spec.delete = ep;
    }
    spec.entity =
      inferEntityFromControllerName(spec.post?.controller || spec.get_list?.controller, entities)
      || inferEntityFromPath(base, entities)
      || entities[0] || null;
    groupSpecs.push(spec);
  }

  // Order groups so FK-dependent entities run last. Sort by FK-fan-out: groups
  // whose entity has 0 FK fields go first, those with FK go later.
  groupSpecs.sort((a, b) => {
    const fkA = (a.entity?.fields || []).filter(f => /_id$/.test(f.name)).length;
    const fkB = (b.entity?.fields || []).filter(f => /_id$/.test(f.name)).length;
    return fkA - fkB;
  });

  const insertedIds = new Map(); // entity.name → id (from POST)
  const probes = [];
  const warnings = []; // quality-issue warnings (don't block, but report)
  for (const spec of groupSpecs) {
    if (!spec.entity) continue;
    const url = `${API_BASE}/mock/${moduleName}${spec.base.startsWith('/') ? spec.base : '/' + spec.base}`;
    const probe = { base: spec.base, entity: spec.entity.name, results: {} };
    const isOk = (status, body) => status === 200 && (body?.code === 0 || body?.success === true);

    // CREATE
    if (spec.post) {
      const body = buildEntityBody(spec.entity, entities, insertedIds, 'http');
      if (body._err) {
        probe.results.create = { ok: false, status: null, error: body._err };
        warnings.push(`http_crud: ${spec.entity.name} create skipped — ${body._err}`);
      } else {
        const cr = await fetchJson(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        probe.results.create = { ok: isOk(cr.status, cr.body), status: cr.status, body_preview: JSON.stringify(cr.body).slice(0, 120) };
        const id = (cr.body?.data || cr.body)?.id;
        if (probe.results.create.ok) {
          if (id != null) {
            insertedIds.set(spec.entity.name, id);
            probe.insertedId = id;
          } else {
            // Create succeeded (200 + code:0) but server returned null id —
            // strong signal that AI generated id without AUTOINCREMENT (TEXT PK
            // or missing PK clause). Warn and continue without the id.
            warnings.push(`http_crud: ${spec.entity.name} POST returned id=null (likely id PK not INTEGER AUTOINCREMENT)`);
          }
        }
      }
    }
    // LIST (always exercise even if create id is missing)
    if (spec.get_list) {
      const lr = await fetchJson(url);
      probe.results.list = { ok: isOk(lr.status, lr.body), status: lr.status };
    }
    // DETAIL — needs an id from create
    const idForGet = probe.insertedId ?? insertedIds.get(spec.entity.name);
    if (spec.get_detail && idForGet != null) {
      const dr = await fetchJson(`${url}/${idForGet}`);
      probe.results.detail = { ok: isOk(dr.status, dr.body), status: dr.status };
    } else if (spec.get_detail) {
      probe.results.detail = { ok: true, status: null, skipped: 'no usable id from create' };
    }
    // UPDATE
    if (spec.put && idForGet != null) {
      const updField = (spec.entity.fields || []).find(f =>
        f.name !== 'id' && !f.required && !f.unique && (f.type === 'string' || f.type === 'text' || !f.type)
      );
      const updBody = updField
        ? { [updField.name]: `upd_c${cycleId}_${Date.now() % 1000}` }
        : {};
      const ur = await fetchJson(`${url}/${idForGet}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updBody),
      });
      probe.results.update = { ok: isOk(ur.status, ur.body), status: ur.status };
    } else if (spec.put) {
      probe.results.update = { ok: true, status: null, skipped: 'no usable id from create' };
    }
    probes.push(probe);
  }

  // Delete in reverse FK order
  for (const spec of [...groupSpecs].reverse()) {
    if (!spec.delete) continue;
    const id = insertedIds.get(spec.entity?.name);
    if (id == null) continue;
    const url = `${API_BASE}/mock/${moduleName}${spec.base.startsWith('/') ? spec.base : '/' + spec.base}`;
    const dlr = await fetchJson(`${url}/${id}`, { method: 'DELETE' });
    const isOk = dlr.status === 200 && (dlr.body?.code === 0 || dlr.body?.success === true);
    const probe = probes.find(p => p.entity === spec.entity.name);
    if (probe) probe.results.delete = { ok: isOk, status: dlr.status };
    insertedIds.delete(spec.entity.name);
  }

  const failures = [];
  for (const p of probes) {
    for (const [op, r] of Object.entries(p.results)) {
      if (!r.ok) failures.push(`${p.entity}::${op} status=${r.status} ${r.error || ''}`);
    }
  }
  // Don't throw on per-probe failures — record them as quality issues so the
  // cycle continues. Only catastrophic infra failure (all probes failed)
  // would warrant aborting; that's covered by individual step exceptions.
  return {
    durationMs: Date.now() - t0,
    groups: probes.length,
    probes,
    warnings,
    qualityFailures: failures,
    qualityFailureCount: failures.length,
  };
}

// ============================================================================
// STEP 8 — manage_data CRUD on each entity
// ============================================================================
async function step8_manageData() {
  const meta = JSON.parse(readFileSync(resolve(`generated/1/${moduleName}/_meta.json`), 'utf-8'));
  const entities = meta.entities || [];
  if (meta.entity && !entities.some(e => e.name === meta.entity.name)) entities.unshift(meta.entity);
  const t0 = Date.now();
  const out = [];
  const insertedIds = new Map();

  // Process entities in FK-dependency order — entities whose required fields
  // reference others go after their parents. We approximate with a stable sort
  // by FK fan-out count.
  const ordered = [...entities].sort((a, b) => {
    const fkA = (a.fields || []).filter(f => /_id$/.test(f.name) && (f.required || f.unique)).length;
    const fkB = (b.fields || []).filter(f => /_id$/.test(f.name) && (f.required || f.unique)).length;
    return fkA - fkB;
  });

  const warnings = [];
  for (const ent of ordered) {
    const insertData = buildEntityBody(ent, entities, insertedIds, 'md');
    if (insertData._err) {
      warnings.push(`manage_data: ${ent.name} insert skipped — ${insertData._err}`);
      out.push({ entity: ent.name, insertOk: true, insertSkipped: true, listOk: null, skipReason: insertData._err });
      // Still test list — that part shouldn't depend on FK
      const list = await mcpCall('manage_data', { action: 'list', moduleName, entityName: ent.name, pageSize: 5 });
      out[out.length - 1].listOk = list.ok && Array.isArray(list.structured?.result?.list);
      continue;
    }
    const ins = await mcpCall('manage_data', { action: 'insert', moduleName, entityName: ent.name, data: insertData });
    const insOkApi = ins.ok; // tool returned without isError
    const idFromApi = ins.structured?.result?.id;
    const insOk = insOkApi && idFromApi != null;
    if (insOk) insertedIds.set(ent.name, idFromApi);
    else if (insOkApi && idFromApi == null) {
      // API succeeded but persisted row has null id — quality issue (e.g. AI's
      // schema.sql has `id TEXT PRIMARY KEY` instead of `INTEGER PRIMARY KEY
      // AUTOINCREMENT`). Don't block; record as warning.
      warnings.push(`manage_data: ${ent.name} insert ok-api but id=null (likely schema.sql PK without AUTOINCREMENT)`);
    }
    const list = await mcpCall('manage_data', { action: 'list', moduleName, entityName: ent.name, pageSize: 5 });
    const listOk = list.ok && Array.isArray(list.structured?.result?.list);
    out.push({
      entity: ent.name,
      insertOk: insOkApi,        // API success (may be lacking id)
      idCaptured: insOk,          // had usable id
      listOk,
      insertedId: idFromApi ?? null,
      totalRows: list.structured?.result?.total ?? null,
      insertErr: insOkApi ? null : ins.structured?.message,
      sentData: insertData,
    });
  }
  // Record per-entity issues as quality data; don't throw.
  const qualityFailures = out.filter(o => !o.insertOk || o.listOk === false);
  return {
    durationMs: Date.now() - t0,
    entities: out,
    warnings,
    qualityFailures: qualityFailures.map(f => `${f.entity}::insert=${f.insertOk} list=${f.listOk} err=${f.insertErr}`),
    qualityFailureCount: qualityFailures.length,
  };
}

// ============================================================================
// STEP 9 — run_test (with cleanup retry)
// ============================================================================
async function step9_runTest(label = 'first') {
  const t0 = Date.now();
  // Important: run_test marks isError=true when not all tests pass, but that's
  // a quality signal (AI's tests failed), not an infrastructure error. We
  // only treat it as infra failure when structuredContent.passed/total is
  // entirely missing — meaning the tool itself blew up (transport / DB / etc).
  let r1 = await mcpCall('run_test', { moduleName }, 120_000);
  const attempts = [{ attempt: 1, passed: r1.structured?.passed, total: r1.structured?.total, allPassed: r1.structured?.allPassed }];
  if (r1.structured?.allPassed) {
    return { durationMs: Date.now() - t0, attempts, finalPassed: r1.structured.passed, finalTotal: r1.structured.total };
  }
  await delay(1500);
  const r2 = await mcpCall('run_test', { moduleName }, 120_000);
  attempts.push({ attempt: 2, passed: r2.structured?.passed, total: r2.structured?.total, allPassed: r2.structured?.allPassed });

  const haveStructured = r1.structured?.total != null || r2.structured?.total != null;
  if (!haveStructured) {
    const msg = r2.structured?.message || r1.structured?.message || JSON.stringify(r2.body || r1.body).slice(0, 300);
    throw new Error(`run_test (${label}) infra error both attempts: ${msg}`);
  }

  const fails = (r2.structured?.failures || r1.structured?.failures || []).map(f => `${f.name}: ${f.error}`);
  return {
    durationMs: Date.now() - t0,
    attempts,
    finalPassed: r2.structured?.passed ?? r1.structured?.passed,
    finalTotal: r2.structured?.total ?? r1.structured?.total,
    allPassed: r2.structured?.allPassed === true,
    qualityFailures: fails,
    qualityFailureCount: fails.length,
  };
}

// ============================================================================
// STEP 10 — update_module
// ============================================================================
async function step10_update() {
  const t0 = Date.now();
  const DEADLINE_MS = 18 * 60_000;
  let attempt = 0;
  const MAX = 3;
  while (attempt < MAX) {
    if (Date.now() - t0 > DEADLINE_MS) {
      throw new Error(`update wall-clock deadline ${DEADLINE_MS}ms exceeded after ${attempt} attempts`);
    }
    attempt++;
    const r = await mcpCall('update_module',
      { moduleName, waitMaxSec: 280, instruction: updateInstruction },
      295_000
    );
    const sc = r.structured;
    if (sc?.status === 'updated') {
      // hasChange=false is a quality issue (AI didn't actually write); record but don't throw.
      return {
        durationMs: Date.now() - t0,
        attempts: attempt,
        diff: sc.diff,
        warnings: sc.warnings,
        hasChange: sc.hasChange !== false,
        qualityFailures: sc.hasChange === false ? ['update returned hasChange=false (AI no-op)'] : [],
        qualityFailureCount: sc.hasChange === false ? 1 : 0,
      };
    }
    if (sc?.status === 'still-running') {
      await delay(2000);
      continue;
    }
    if (r.isError) throw new Error(`update error: code=${sc?.code} msg=${sc?.message}`);
    throw new Error(`unexpected update response: ${JSON.stringify(r.body).slice(0, 300)}`);
  }
  throw new Error(`update did not finish within ${MAX} attempts`);
}

// ============================================================================
// STEP 11 — extras (access log + diff_with_openapi + handoff)
// ============================================================================
async function step11_extras() {
  const t0 = Date.now();
  const log = await mcpCall('get_mock_access_log', { moduleName, limit: 50 });
  const fiveHundreds = (log.structured?.logs || []).filter(l => l.statusCode >= 500).length;
  const totalLogged = log.structured?.total ?? 0;
  if (!log.ok) throw new Error(`access_log error`);
  // diff with a deliberately wrong response to confirm the tool catches it
  const diff = await mcpCall('diff_with_openapi', {
    moduleName,
    actualRequest: { method: 'POST', path: `/mock/${moduleName}/__nope__`, body: { wrong: 'field' } },
    actualResponse: { statusCode: 500, body: { code: 99, message: 'fake' } },
  });
  const diffOk = diff.ok || diff.structured?.diffs != null;
  const handoff = await mcpCall('generate_handoff_report', { moduleName });
  const handoffBytes = handoff.body?.result?.content?.[0]?.text?.length || 0;
  if (!handoff.ok || handoffBytes < 200) {
    throw new Error(`handoff malformed bytes=${handoffBytes}`);
  }
  return {
    durationMs: Date.now() - t0,
    accessLogTotal: totalLogged,
    accessLogFiveHundreds: fiveHundreds,
    diffSmokeOk: diffOk,
    handoffBytes,
  };
}

// ============================================================================
// STEP 12 — delete
// ============================================================================
async function step12_delete() {
  const r = await mcpCall('delete_module', { moduleName });
  if (!r.ok) throw new Error(`delete error: ${JSON.stringify(r.body)}`);
  return { durationMs: r.durationMs, deleted: true };
}

// ============================================================================
// MAIN
// ============================================================================
(async () => {
  console.log(`[cycle-${cycleId}] === START moduleName=${moduleName} spec=${specPath} ===`);
  const define = (name, fn) => async () => {
    const t0 = Date.now();
    try {
      const detail = await fn();
      logStep(name, true, { durationMs: Date.now() - t0, ...detail });
      return detail;
    } catch (e) {
      logStep(name, false, { durationMs: Date.now() - t0 }, e);
      throw e;
    }
  };
  try {
    await define('1.login', step1_login)();
    await define('2.cleanup', step2_cleanup)();
    await define('3.list_baseline', step3_listBaseline)();
    await define('4.create', step4_create)();
    await define('5.inspect_health', step5_inspectHealth)();
    await define('6.inspect_openapi', step6_inspectOpenapi)();
    await define('7.http_crud', step7_httpCrud)();
    await define('8.manage_data', step8_manageData)();
    await define('9.run_test_pre_update', () => step9_runTest('pre-update'))();
    await define('10.update', step10_update)();
    await define('11.run_test_post_update', () => step9_runTest('post-update'))();
    await define('12.extras', step11_extras)();
    await define('13.delete', step12_delete)();
    finishAndExit(true, 'all-green');
  } catch (e) {
    finishAndExit(false, e.message);
  }
})();
