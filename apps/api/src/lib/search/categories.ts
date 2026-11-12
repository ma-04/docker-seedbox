/**
 * The fixed search category list and its mapping to Torznab/Newznab standard category ids
 * (https://torznab.github.io/spec-1.3-draft/external/newznab/api.html#predefined-categories).
 * Admins can switch categories off (setting `search.disabledCategories`, default: XXX off). A disabled category is
 * neither offered nor sent to the backend, and results that carry one of its ids are dropped server-side, also from "All".
 */
export const SEARCH_CATEGORIES = [
  { id: 'movies', label: 'Movies', torznab: [2000] },
  { id: 'tv', label: 'TV', torznab: [5000] },
  { id: 'music', label: 'Music', torznab: [3000] },
  { id: 'audiobooks', label: 'Audiobooks', torznab: [3030] },
  { id: 'books', label: 'Books', torznab: [7000] },
  { id: 'software', label: 'Software / PC', torznab: [4000] },
  { id: 'games', label: 'Games', torznab: [1000, 4050] },
  { id: 'anime', label: 'Anime', torznab: [5070] },
  { id: 'other', label: 'Other', torznab: [8000] },
  { id: 'xxx', label: 'XXX', torznab: [6000] },
] as const;

export type CategoryId = (typeof SEARCH_CATEGORIES)[number]['id'];
export const CATEGORY_IDS = SEARCH_CATEGORIES.map((c) => c.id) as [CategoryId, ...CategoryId[]];
export const DEFAULT_DISABLED_CATEGORIES: CategoryId[] = ['xxx'];

/** Subcategories that are categories of their own here; checked before the thousand-block families. */
const SUBCATS: Record<number, CategoryId> = { 3030: 'audiobooks', 5070: 'anime', 4050: 'games' };
const FAMILIES: Record<number, CategoryId> = {
  1000: 'games', 2000: 'movies', 3000: 'music', 4000: 'software', 5000: 'tv', 6000: 'xxx', 7000: 'books', 8000: 'other',
};

/**
 * Our category for one Torznab category id, or null for ids outside the standard range (Jackett adds the tracker's own
 * ids as >= 100000 alongside the standard ones; those carry no meaning here).
 */
export function classify(id: number): CategoryId | null {
  if (!Number.isInteger(id) || id < 1000 || id >= 100000) return null;
  if (SUBCATS[id]) return SUBCATS[id]!;
  return FAMILIES[Math.floor(id / 1000) * 1000] ?? null;
}

/** All of a result's categories; the first entry is the most specific one (a subcategory match wins). */
export function classifyAll(ids: number[]): CategoryId[] {
  const out: CategoryId[] = [];
  const sub = ids.filter((i) => SUBCATS[i]).map((i) => SUBCATS[i]!);
  for (const c of [...sub, ...ids.map(classify)]) if (c && !out.includes(c)) out.push(c);
  return out;
}

export function enabledCategories(disabled: readonly string[]): (typeof SEARCH_CATEGORIES)[number][] {
  return SEARCH_CATEGORIES.filter((c) => !disabled.includes(c.id));
}

/**
 * Torznab `cat` ids for a query. `all` = every ENABLED category (never an empty list: with nothing enabled there is
 * nothing to search). Throws for a disabled or unknown category.
 */
export function torznabCats(category: 'all' | CategoryId, disabled: readonly string[]): number[] {
  const enabled = enabledCategories(disabled);
  if (category === 'all') return enabled.flatMap((c) => [...c.torznab]);
  const c = enabled.find((x) => x.id === category);
  if (!c) throw new Error('category disabled');
  return [...c.torznab];
}

/**
 * A result is shown only if none of its standard categories is disabled. One that carries NO standard category (only the
 * tracker's own ids >= 100000, i.e. Jackett could not map it) cannot be checked: it is dropped while any category is
 * disabled (it might be XXX), and shown as `other` only when every category is enabled.
 */
export function resultCategory(ids: number[], disabled: readonly string[]): CategoryId | null {
  const all = classifyAll(ids);
  if (all.length === 0) return disabled.length === 0 ? 'other' : null;
  if (all.some((c) => disabled.includes(c))) return null;
  return all[0]!;
}
