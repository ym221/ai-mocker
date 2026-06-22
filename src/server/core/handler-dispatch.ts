/**
 * Shared controller-handler resolver.
 *
 * Both the live mock-router and the post-generation smoke test need to map an
 * endpoint to the right exported controller function. Historically they each had
 * their own dispatch logic, and the smoke test's was weaker — it only tried the
 * single-entity names (`list`/`getById`), so it false-failed multi-entity modules
 * whose exports follow the `<verb><Entity>` convention (listProducts, getStats,
 * payOrder). That made the smoke gate reject modules the router actually serves.
 *
 * This module is the single source of truth. It resolves a handler purely from
 * what the controller actually exports, trying a broad set of conventional names
 * derived from the endpoint's type + path. Candidates are only ever matched
 * against real exports, so a wide candidate list is safe.
 */

export interface DispatchEndpoint {
  method?: string;
  path?: string;
  type?: string;
  /** Explicit binding from _meta.endpoints[].controller — always wins when present. */
  controller?: string;
  /** Legacy hints some generations emit. */
  handler?: string;
  name?: string;
}

const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const lower = (s: string): string => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** Convert a path segment (snake/kebab/camel) to lowerCamel: hot_deals → hotDeals. */
function toCamel(seg: string): string {
  const c = seg.replace(/[_-]+([a-zA-Z0-9])/g, (_, ch) => ch.toUpperCase());
  return lower(c);
}

/**
 * Singularizing English plurals is ambiguous ("courses"→"course" vs "buses"→"bus"),
 * so instead of guessing one form we return ALL plausible singular/normal forms.
 * The caller tries every one against the real exports, so over-generating is safe.
 * e.g. courses → [courses, course, cours]; categories → [categories, category];
 *      products → [products, product].
 */
function entityForms(word: string): string[] {
  const forms = new Set<string>([word]);
  if (/ies$/i.test(word)) forms.add(word.slice(0, -3) + 'y');     // categories → category
  if (/(ses|xes|zes|ches|shes)$/i.test(word)) forms.add(word.slice(0, -2)); // buses → bus
  if (/s$/i.test(word) && !/ss$/i.test(word)) forms.add(word.slice(0, -1)); // courses → course, products → product
  return [...forms];
}

/** Non-parameter path segments, e.g. /orders/:id/pay → ['orders', 'pay']. */
function literalSegments(path: string): string[] {
  return (path || '')
    .split('/')
    .filter(Boolean)
    .filter(s => !s.startsWith(':') && !s.startsWith('{'));
}

/**
 * Build the ordered list of candidate export names for an endpoint.
 * Order matters only for the rare case where a controller exports several of
 * them; bare single-entity verbs come first to preserve historical behavior.
 */
export function candidateHandlerNames(ep: DispatchEndpoint): string[] {
  const out: string[] = [];
  const push = (...names: (string | undefined | null)[]) => {
    for (const n of names) if (n && !out.includes(n)) out.push(n);
  };

  // Explicit / legacy hints first.
  push(ep.controller, ep.handler, ep.name);

  const segs = literalSegments(ep.path || '');
  const last = segs[segs.length - 1] || '';
  const prev = segs[segs.length - 2] || '';
  const type = (ep.type || '').toLowerCase();
  const method = (ep.method || '').toUpperCase();

  const lastCamel = toCamel(last);
  // Pascal-cased forms of the last segment (plural + singular variants), e.g.
  // "courses" → ['Courses','Course','Cours']. Tried against real exports, so safe.
  const lastForms = entityForms(lastCamel).map(cap);
  const prevForms = entityForms(toCamel(prev)).map(cap);

  const verbsByType: Record<string, string[]> = {
    list: ['list', 'findAll', 'getAll', 'search', 'index'],
    detail: ['getById', 'get', 'detail', 'findOne', 'show'],
    create: ['create', 'add', 'insert', 'store'],
    update: ['update', 'edit', 'modify', 'patch'],
    delete: ['remove', 'delete', 'del', 'destroy'],
  };

  if (type in verbsByType) {
    // For CRUD endpoints the collection token is the last literal segment.
    const verbs = verbsByType[type];
    // 1) Path-entity-specific names FIRST. Critical for nested / secondary-entity
    //    endpoints: GET /tickets/:id/comments must bind `listComments`, not the
    //    module's bare `list` (which belongs to the primary entity). For a root
    //    path ("/") lastForms is [""], so v+"" == the bare verb — the single-entity
    //    case still resolves to `list`/`create`/`getById` first.
    for (const v of verbs) {
      for (const e of lastForms) {
        push(v + e);                           // listComments / listProducts / list
        if (type === 'detail') {
          push(v + e + 'ById');                // getProductById / getCourseById
          push('get' + e + 'ById');
        }
      }
    }
    // 2) Bare verbs as fallback (primary-entity / root-path convention).
    for (const v of verbs) push(v);            // list / getById / create ...
    for (const e of entityForms(lastCamel)) push(e);  // products / product / course
  } else {
    // custom (and anything else): treat the last literal segment as the action,
    // the preceding one (if any) as the entity it acts on.
    const action = lastCamel;                  // pay / stats / search
    push(action);                              // pay / stats
    push('get' + cap(action), 'do' + cap(action), 'post' + cap(action));  // getStats
    for (const e of prevForms) {
      if (!e) continue;
      push(action + e);                        // payOrder / payOrders
      push(toCamel(prev) + cap(action));       // ordersPay
    }
    // A POST to a bare collection (POST /orders, type=custom) is usually a create.
    if (method === 'POST' && !prev) {
      for (const e of lastForms) push('create' + e, 'add' + e);  // createOrder
    }
    // A GET custom on a collection often mirrors list naming.
    if (method === 'GET') {
      for (const e of lastForms) push('list' + e);
    }
  }

  return out;
}

/**
 * Resolve the endpoint to an exported function name on `ctrl`.
 * Returns the matched name, or null if nothing matches.
 */
export function resolveHandlerName(
  ctrl: Record<string, unknown>,
  ep: DispatchEndpoint,
): string | null {
  for (const name of candidateHandlerNames(ep)) {
    if (typeof ctrl[name] === 'function') return name;
  }
  return null;
}
