import { ref, watch, type Ref } from 'vue';
import type { ColumnConfig, TableDensity, TablePreferences } from '../components/data-table/types';

const PREFIX = 'tablePrefs:';

function load(storageKey: string): TablePreferences | null {
  try {
    const raw = localStorage.getItem(PREFIX + storageKey);
    if (!raw) return null;
    return JSON.parse(raw) as TablePreferences;
  } catch {
    return null;
  }
}

function save(storageKey: string, prefs: TablePreferences) {
  try {
    localStorage.setItem(PREFIX + storageKey, JSON.stringify(prefs));
  } catch {
    /* quota exceeded — ignore */
  }
}

function mergeColumns(defaults: ColumnConfig[], saved: ColumnConfig[]): ColumnConfig[] {
  const savedMap = new Map(saved.map(c => [c.id, c]));
  // Start with saved order, but only keep columns still defined in defaults
  const defaultMap = new Map(defaults.map(c => [c.id, c]));
  const merged: ColumnConfig[] = [];
  const seen = new Set<string>();
  for (const s of saved) {
    const def = defaultMap.get(s.id);
    if (!def) continue;
    merged.push({
      ...def,
      visible: def.fixed ? true : s.visible,
      pinned: s.pinned,
    });
    seen.add(s.id);
  }
  // Append new columns not present in saved (keep default order among them)
  for (const d of defaults) {
    if (!seen.has(d.id)) merged.push({ ...d });
  }
  return merged;
}

export function useTablePreferences(
  storageKey: string | undefined,
  defaults: () => ColumnConfig[],
  initialDensity: TableDensity = 'normal',
): {
  columns: Ref<ColumnConfig[]>;
  density: Ref<TableDensity>;
  presets: Ref<Record<string, { columns: ColumnConfig[]; density: TableDensity }>>;
  activePreset: Ref<string | undefined>;
  reset: () => void;
  savePreset: (name: string) => void;
  loadPreset: (name: string) => void;
  deletePreset: (name: string) => void;
} {
  const defaultCols = defaults();
  const saved = storageKey ? load(storageKey) : null;

  const columns = ref<ColumnConfig[]>(
    saved?.columns ? mergeColumns(defaultCols, saved.columns) : defaultCols.map(c => ({ ...c }))
  ) as Ref<ColumnConfig[]>;
  const density = ref<TableDensity>(saved?.density ?? initialDensity);
  const presets = ref<Record<string, { columns: ColumnConfig[]; density: TableDensity }>>(saved?.presets ?? {});
  const activePreset = ref<string | undefined>(saved?.activePreset);

  if (storageKey) {
    watch([columns, density, presets, activePreset], () => {
      save(storageKey, {
        columns: columns.value,
        density: density.value,
        presets: presets.value,
        activePreset: activePreset.value,
      });
    }, { deep: true });
  }

  function reset() {
    columns.value = defaults().map(c => ({ ...c }));
    density.value = initialDensity;
    activePreset.value = undefined;
  }

  function savePreset(name: string) {
    presets.value = {
      ...presets.value,
      [name]: {
        columns: JSON.parse(JSON.stringify(columns.value)),
        density: density.value,
      },
    };
    activePreset.value = name;
  }

  function loadPreset(name: string) {
    const p = presets.value[name];
    if (!p) return;
    columns.value = mergeColumns(defaults(), p.columns);
    density.value = p.density;
    activePreset.value = name;
  }

  function deletePreset(name: string) {
    const next = { ...presets.value };
    delete next[name];
    presets.value = next;
    if (activePreset.value === name) activePreset.value = undefined;
  }

  return { columns, density, presets, activePreset, reset, savePreset, loadPreset, deletePreset };
}
