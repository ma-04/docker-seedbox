import { describe, expect, it } from 'vitest';
import type { SearchResultDto } from './api';
import { nextSort, queryProblem, sortResults } from './search';

const r = (title: string, seeders: number, size: number, publishedAt: number | null): SearchResultDto => ({
  token: title, title, seeders, size, publishedAt, leechers: 0, indexer: { id: 'x', name: 'X' }, category: 'movies',
});
const rows = [r('a', 5, 300, 10), r('b', 50, 100, null), r('c', 5, 200, 30)];

describe('search result sorting', () => {
  it('sorts by seeders, size and date in both directions; ties keep the server order', () => {
    expect(sortResults(rows, 'seeders', 'desc').map((x) => x.title)).toEqual(['b', 'a', 'c']);
    expect(sortResults(rows, 'seeders', 'asc').map((x) => x.title)).toEqual(['a', 'c', 'b']);
    expect(sortResults(rows, 'size', 'desc').map((x) => x.title)).toEqual(['a', 'c', 'b']);
    expect(sortResults(rows, 'date', 'desc').map((x) => x.title)).toEqual(['c', 'a', 'b']); // unknown dates last
    expect(sortResults(rows, 'date', 'asc').map((x) => x.title)).toEqual(['b', 'a', 'c']);
  });
  it('toggles direction on the active column, starts descending on a new one', () => {
    expect(nextSort({ key: 'seeders', dir: 'desc' }, 'seeders')).toEqual({ key: 'seeders', dir: 'asc' });
    expect(nextSort({ key: 'seeders', dir: 'asc' }, 'size')).toEqual({ key: 'size', dir: 'desc' });
  });
  it('mirrors the API query rule', () => {
    expect(queryProblem(' a ')).toMatch(/at least/);
    expect(queryProblem('ab')).toBeNull();
    expect(queryProblem('x'.repeat(201))).toMatch(/At most/);
  });
});
