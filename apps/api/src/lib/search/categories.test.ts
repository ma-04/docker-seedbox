import { describe, expect, it } from 'vitest';
import { classify, classifyAll, enabledCategories, resultCategory, SEARCH_CATEGORIES, torznabCats } from './categories.js';

describe('category mapping (Torznab/Newznab standard ids)', () => {
  it('maps every category to the documented ids', () => {
    expect(Object.fromEntries(SEARCH_CATEGORIES.map((c) => [c.id, c.torznab]))).toEqual({
      movies: [2000], tv: [5000], music: [3000], audiobooks: [3030], books: [7000], software: [4000],
      games: [1000, 4050], anime: [5070], other: [8000], xxx: [6000],
    });
  });

  it('classifies standard ids, subcategories first; tracker-specific ids (>= 100000) mean nothing', () => {
    expect(classify(2040)).toBe('movies');
    expect(classify(5070)).toBe('anime');
    expect(classify(5040)).toBe('tv');
    expect(classify(3030)).toBe('audiobooks');
    expect(classify(3010)).toBe('music');
    expect(classify(4050)).toBe('games');
    expect(classify(4010)).toBe('software');
    expect(classify(1080)).toBe('games');
    expect(classify(6010)).toBe('xxx');
    expect(classify(7020)).toBe('books');
    expect(classify(8010)).toBe('other');
    expect(classify(100003)).toBeNull();
    expect(classify(0)).toBeNull();
    expect(classify(999)).toBeNull();
    expect(classifyAll([5000, 5070, 100002])).toEqual(['anime', 'tv']);
  });

  it('All = every enabled category; a disabled one cannot be asked for', () => {
    const all = torznabCats('all', ['xxx']);
    expect(all).not.toContain(6000);
    expect(all).toEqual([2000, 5000, 3000, 3030, 7000, 4000, 1000, 4050, 5070, 8000]);
    expect(torznabCats('all', [])).toContain(6000);
    expect(torznabCats('games', ['xxx'])).toEqual([1000, 4050]);
    expect(() => torznabCats('xxx', ['xxx'])).toThrow();
    expect(enabledCategories(['xxx', 'anime']).map((c) => c.id)).not.toContain('anime');
  });

  it('drops results carrying a disabled category, also when they sit in an enabled one too', () => {
    expect(resultCategory([6000, 100003], ['xxx'])).toBeNull();
    expect(resultCategory([2000, 6040], ['xxx'])).toBeNull();
    expect(resultCategory([5000, 5070], ['anime'])).toBeNull();
    expect(resultCategory([5000, 5070], ['xxx'])).toBe('anime');
    expect(resultCategory([3000, 3030], [])).toBe('audiobooks');
    expect(resultCategory([100005], ['xxx'])).toBe('other');
    expect(resultCategory([], ['other'])).toBeNull();
    expect(resultCategory([6000], [])).toBe('xxx');
  });
});
