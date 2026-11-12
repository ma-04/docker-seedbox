import type { SearchResultDto } from './api';

export type SortKey = 'seeders' | 'size' | 'date';
export type SortDir = 'asc' | 'desc';

/** Client-side sort of search results; ties keep the server order (seeders desc). */
export function sortResults(rows: SearchResultDto[], key: SortKey, dir: SortDir): SearchResultDto[] {
  const v = (r: SearchResultDto): number => (key === 'seeders' ? r.seeders : key === 'size' ? r.size : (r.publishedAt ?? -Infinity));
  const sign = dir === 'asc' ? 1 : -1;
  return rows.map((r, i) => [r, i] as const).sort((a, b) => (v(a[0]) - v(b[0])) * sign || a[1] - b[1]).map(([r]) => r);
}

/** Clicking the active column flips its direction; another column starts descending (biggest / newest first). */
export function nextSort(cur: { key: SortKey; dir: SortDir }, key: SortKey): { key: SortKey; dir: SortDir } {
  return cur.key === key ? { key, dir: cur.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' };
}

/** Client-side mirror of the API's query rule: 2-200 characters after trimming. */
export function queryProblem(q: string): string | null {
  const t = q.trim();
  if (t.length < 2) return 'Enter at least 2 characters';
  if (t.length > 200) return 'At most 200 characters';
  return null;
}
