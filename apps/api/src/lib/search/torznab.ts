/** Torznab response parsing (RSS 2.0 + `torznab:attr`). Input is untrusted: see lib/search/xml.ts for the parser's limits. */
import { SearchError, type IndexerInfo } from './backend.js';
import { childText, kids, parseXml, XmlError, type XmlNode } from './xml.js';

export const MAX_RESULTS = 100;
export const MAX_TITLE_CHARS = 300;
const INDEXER_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** One item as the protocol describes it; `link` is the raw download URL (the adapter decides what to keep). */
export interface TorznabItem {
  title: string; size: number; seeders: number; leechers: number;
  indexerId: string | null; indexerName: string | null;
  categories: number[]; publishedAt: number | null;
  magnet: string | null; link: string | null;
}

/** Control/format characters out, whitespace collapsed, capped. */
export function cleanText(raw: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
  return [...s].slice(0, max).join('');
}

const nonNegInt = (v: string | null | undefined): number | null => {
  if (v === null || v === undefined || !/^\s*\d{1,16}\s*$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
};

function parseRoot(xml: string): XmlNode {
  let root: XmlNode;
  try { root = parseXml(xml); } catch (e) {
    if (e instanceof XmlError) throw new SearchError('bad_response', `The search backend sent an invalid response (${e.message})`);
    throw e;
  }
  if (root.name === 'error') {
    const code = root.attrs.code ?? '';
    // Torznab error codes 100-199 are client/auth problems (100 = bad API key, 201 = unknown function ...).
    throw new SearchError('rejected', `The search backend refused the request${/^\d{1,4}$/.test(code) ? ` (Torznab error ${code})` : ''}`);
  }
  return root;
}

export function parseTorznabResults(xml: string, maxItems = MAX_RESULTS): { items: TorznabItem[]; total: number } {
  const root = parseRoot(xml);
  const channel = root.name === 'rss' ? kids(root, 'channel')[0] : undefined;
  if (!channel) throw new SearchError('bad_response', 'The search backend sent an invalid response (no RSS channel)');
  const all = kids(channel, 'item');
  const items: TorznabItem[] = [];
  for (const it of all) {
    if (items.length >= maxItems) break;
    const title = cleanText(childText(it, 'title') ?? '', MAX_TITLE_CHARS);
    if (!title) continue;
    const attrs = new Map<string, string[]>();
    for (const a of kids(it, 'torznab:attr')) {
      const n = a.attrs.name, v = a.attrs.value;
      if (n === undefined || v === undefined) continue;
      const list = attrs.get(n);
      if (list) list.push(v); else attrs.set(n, [v]); // in place: copying the array per attribute was quadratic
    }
    const attr = (n: string) => attrs.get(n)?.[0] ?? null;
    const enclosure = kids(it, 'enclosure')[0];
    const cats = new Set<number>();
    for (const c of [...kids(it, 'category').map((c) => c.text.trim()), ...(attrs.get('category') ?? [])]) {
      const n = nonNegInt(c);
      if (n !== null && cats.size < 20) cats.add(n);
    }
    const seeders = nonNegInt(attr('seeders')) ?? 0;
    const peers = nonNegInt(attr('peers'));
    const leechers = nonNegInt(attr('leechers')) ?? (peers !== null ? Math.max(0, peers - seeders) : 0);
    const date = Date.parse(childText(it, 'pubDate') ?? '');
    const idx = kids(it, 'jackettindexer')[0];
    const indexerId = idx?.attrs.id && INDEXER_ID.test(idx.attrs.id) ? idx.attrs.id : null;
    const magnet = attr('magneturl');
    const link = childText(it, 'link') || enclosure?.attrs.url || null;
    items.push({
      title,
      size: nonNegInt(childText(it, 'size')) ?? nonNegInt(attr('size')) ?? nonNegInt(enclosure?.attrs.length) ?? 0,
      seeders, leechers,
      indexerId,
      indexerName: idx ? cleanText(idx.text, 100) || indexerId : null,
      categories: [...cats],
      publishedAt: Number.isFinite(date) ? Math.floor(date / 1000) : null,
      magnet: magnet && /^magnet:\?/i.test(magnet) ? magnet : null,
      link,
    });
  }
  return { items, total: all.length };
}

/** Jackett's `t=indexers&configured=true` answer: `<indexers><indexer id configured><title>`. */
export function parseTorznabIndexers(xml: string): IndexerInfo[] {
  const root = parseRoot(xml);
  if (root.name !== 'indexers') throw new SearchError('bad_response', 'The search backend sent an invalid response (no indexer list)');
  const out: IndexerInfo[] = [];
  for (const n of kids(root, 'indexer')) {
    const id = n.attrs.id;
    if (!id || !INDEXER_ID.test(id) || n.attrs.configured === 'false') continue;
    if (out.some((x) => x.id === id) || out.length >= 500) continue;
    out.push({ id, name: cleanText(childText(n, 'title') ?? '', 100) || id });
  }
  return out;
}
