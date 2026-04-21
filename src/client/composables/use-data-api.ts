import { useApi } from './use-api';

export type FieldRule =
  | { kind: 'faker' }
  | { kind: 'sequence'; prefix?: string; start?: number }
  | { kind: 'fixed'; value: unknown };

export interface DataRow { id: number; [key: string]: unknown }
export interface ListResult { list: DataRow[]; total: number; page: number; pageSize: number }
export interface FilterEntry {
  op?: string;
  value?: string | number;
  min?: string | number;
  max?: string | number;
}

export interface ListParams {
  page?: number;
  pageSize?: number;
  orderBy?: string;
  // Simple filter: field → value (LIKE on string, eq on others)
  // Or operator filter: field → { op, value, min, max }
  filter?: Record<string, string | number | FilterEntry>;
}

export function useDataApi(moduleName: string) {
  const api = useApi();
  const base = `/api/data/${encodeURIComponent(moduleName)}`;

  function list(params: ListParams = {}) {
    const q = new URLSearchParams();
    if (params.page) q.set('page', String(params.page));
    if (params.pageSize) q.set('pageSize', String(params.pageSize));
    if (params.orderBy) q.set('orderBy', params.orderBy);
    if (params.filter) {
      for (const [k, v] of Object.entries(params.filter)) {
        if (v === '' || v === null || v === undefined) continue;
        if (typeof v === 'object') {
          const entry = v as FilterEntry;
          if (entry.op) q.set(`filter[${k}][op]`, String(entry.op));
          if (entry.value !== undefined && entry.value !== '') q.set(`filter[${k}][value]`, String(entry.value));
          if (entry.min !== undefined && entry.min !== '') q.set(`filter[${k}][min]`, String(entry.min));
          if (entry.max !== undefined && entry.max !== '') q.set(`filter[${k}][max]`, String(entry.max));
        } else {
          q.set(`filter[${k}]`, String(v));
        }
      }
    }
    const qs = q.toString();
    return api.get<{ success: boolean; data: ListResult }>(`${base}${qs ? '?' + qs : ''}`);
  }

  function create(data: Record<string, unknown>) {
    return api.post<{ success: boolean; data: DataRow }>(base, data);
  }

  function update(id: number, data: Record<string, unknown>) {
    return api.put<{ success: boolean; data: DataRow }>(`${base}/${id}`, data);
  }

  function remove(id: number) {
    return api.del<{ success: boolean; data: { deleted: boolean } }>(`${base}/${id}`);
  }

  function batchDelete(ids: number[]) {
    return api.post<{ success: boolean; data: { deleted: number } }>(`${base}/batch-delete`, { ids });
  }

  function clear() {
    return api.post<{ success: boolean; data: { cleared: number } }>(`${base}/clear`);
  }

  function bulkGenerate(count: number, rules?: Record<string, FieldRule>) {
    return api.post<{ success: boolean; data: { generated: number } }>(`${base}/bulk-generate`, { count, rules });
  }

  return { list, create, update, remove, batchDelete, clear, bulkGenerate };
}
