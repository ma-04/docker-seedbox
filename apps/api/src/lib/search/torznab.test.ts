import { describe, expect, it } from 'vitest';
import { SearchError } from './backend.js';
import { dlLink, INDEXERS_XML, magnetOf, torznabXml } from './fixtures.js';
import { cleanText, parseTorznabIndexers, parseTorznabResults } from './torznab.js';

describe('parseTorznabResults', () => {
  it('normalises a Jackett answer', () => {
    const xml = torznabXml([
      { title: 'E2E Search Slow File', cats: [5000, 100002], seeders: 120, peers: 150, magnet: magnetOf(), link: dlLink('AAA') },
      { title: 'E2E Search Single File', cats: [2000, 100001], seeders: 42, peers: 45, link: dlLink('BBB'), size: 2000000 },
    ]);
    const { items, total } = parseTorznabResults(xml);
    expect(total).toBe(2);
    expect(items[0]).toMatchObject({
      title: 'E2E Search Slow File', size: 8000000, seeders: 120, leechers: 30, indexerId: 'sbmock', indexerName: 'SeedboxE2E',
      categories: [5000, 100002], publishedAt: Date.UTC(2026, 10, 12, 2, 21, 53) / 1000,
    });
    expect(items[0]!.magnet).toMatch(/^magnet:\?xt=urn:btih:16b03c/);
    expect(items[0]!.magnet).toContain('&dn=slow2&tr='); // &amp; decoded
    expect(items[1]!.magnet).toBeNull();
    expect(items[1]!.link).toBe('http://vpn:9117/jackett/dl/sbmock/?jackett_apikey=0123456789abcdefghijklmnopqrstuv&path=BBB&file=Some+File');
  });

  it('caps the number of results and skips items without a title', () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ title: i === 0 ? '   ' : `T${i}`, cats: [2000], link: dlLink(String(i)) }));
    const { items, total } = parseTorznabResults(torznabXml(many));
    expect(total).toBe(150);
    expect(items).toHaveLength(100);
    expect(items[0]!.title).toBe('T1');
  });

  it('sanitises hostile values: control characters, absurd numbers, non-magnet magneturl', () => {
    const xml = torznabXml([{ title: 'Evil&#x202E;gnp.exe &#10;&#9;line', cats: [99999999999999999, 2000], seeders: -1, magnet: 'javascript:alert(1)', link: dlLink('x') }])
      .replace('<size>8000000</size>', '<size>1e309</size>').replace(/<pubDate>[^<]*/, '<pubDate>garbage');
    const it0 = parseTorznabResults(xml).items[0]!;
    expect(it0.title).toBe('Evil gnp.exe line');
    expect(it0.categories).toEqual([2000]);
    expect(it0.seeders).toBe(0);
    expect(it0.magnet).toBeNull();
    expect(it0.publishedAt).toBeNull();
    expect(it0.size).toBe(8000000); // falls back to the enclosure length
  });

  it('a Torznab <error> is a refusal; other roots are bad responses; XXE never parses', () => {
    try { parseTorznabResults('<?xml version="1.0"?><error code="100" description="Invalid API Key: 0123"/>'); expect.unreachable(); } catch (e) {
      expect(e).toBeInstanceOf(SearchError);
      expect((e as SearchError).code).toBe('rejected');
      expect((e as SearchError).message).not.toContain('0123'); // the description is never echoed
    }
    expect(() => parseTorznabResults('<html><body>Login</body></html>')).toThrow(/no RSS channel/);
    const xxe = '<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss><channel><item><title>&x;</title></item></channel></rss>';
    try { parseTorznabResults(xxe); expect.unreachable(); } catch (e) { expect((e as SearchError).code).toBe('bad_response'); }
  });
});

describe('parseTorznabResults: cost stays linear in the input', () => {
  it('many same-name attributes (within the caps) parse quickly and scale linearly', () => {
    const time = (n: number) => {
      const xml = `<rss><channel><item><title>x</title>${'<torznab:attr name="category" value="2000"/>'.repeat(n)}</item></channel></rss>`;
      const t = performance.now();
      parseTorznabResults(xml);
      return performance.now() - t;
    };
    time(1000); // warm-up
    const small = time(25_000);
    const big = time(100_000); // 4.4 MB, under the 5 MiB cap; quadratic was 37 s at 150k
    expect(big).toBeLessThan(2000);
    expect(big / Math.max(small, 1)).toBeLessThan(10); // 4x the input: linear ~4x, quadratic ~16x
  });
});

describe('parseTorznabIndexers', () => {
  it('lists configured indexers with valid ids only', () => {
    expect(parseTorznabIndexers(INDEXERS_XML)).toEqual([{ id: 'sbmock', name: 'SeedboxE2E' }, { id: 'other-one', name: 'Other & One' }]);
    expect(parseTorznabIndexers('<indexers />')).toEqual([]);
    expect(() => parseTorznabIndexers('<rss/>')).toThrow(SearchError);
  });
});

describe('cleanText', () => {
  it('caps by code points, never splitting a surrogate pair', () => {
    expect(cleanText('😀'.repeat(5), 3)).toBe('😀😀😀');
  });
});
