/** Test fixtures: Torznab answers shaped exactly like Jackett's (captured from Jackett 0.24 against the e2e mock indexer). */
export const KEY = '0123456789abcdefghijklmnopqrstuv';
export const ORIGIN = 'http://vpn:9117';
export const HASH1 = '16b03c55743318b33972b28e05610996130e91d1';

export function dlLink(path: string, origin = ORIGIN, key = KEY): string {
  return `${origin}/jackett/dl/sbmock/?jackett_apikey=${key}&amp;path=${path}&amp;file=Some+File`;
}

export interface FixtureItem { title: string; cats: number[]; seeders?: number; peers?: number; magnet?: string; link?: string; size?: number; date?: string; indexer?: string }

export function torznabXml(items: FixtureItem[]): string {
  const body = items.map((i) => `
    <item>
      <title>${i.title}</title>
      <guid>http://203.0.113.40:8080/dl/x.torrent</guid>
      <jackettindexer id="${i.indexer ?? 'sbmock'}">SeedboxE2E</jackettindexer>
      <type>public</type>
      <comments>http://203.0.113.40:8080/details/x</comments>
      <pubDate>${i.date ?? 'Thu, 12 Nov 2026 02:21:53 +0000'}</pubDate>
      <size>${i.size ?? 8000000}</size>
      <description />
      ${i.link !== undefined ? `<link>${i.link}</link>` : ''}
      ${i.cats.map((c) => `<category>${c}</category>`).join('')}
      ${i.link !== undefined ? `<enclosure url="${i.link}" length="${i.size ?? 8000000}" type="application/x-bittorrent" />` : ''}
      ${i.cats.map((c) => `<torznab:attr name="category" value="${c}" />`).join('')}
      <torznab:attr name="seeders" value="${i.seeders ?? 10}" />
      <torznab:attr name="peers" value="${i.peers ?? 15}" />
      ${i.magnet ? `<torznab:attr name="magneturl" value="${i.magnet}" />` : ''}
      <torznab:attr name="downloadvolumefactor" value="1" />
    </item>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <atom:link href="${ORIGIN}/jackett/" rel="self" type="application/rss+xml" />
    <title>AggregateSearch</title>
    <description>This feed includes all configured trackers</description>
    <link>http://127.0.0.1/</link>
    <language>en-US</language>
    <category>search</category>${body}
  </channel>
</rss>`;
}

export const INDEXERS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<indexers>
  <indexer id="sbmock" configured="true">
    <title>SeedboxE2E</title>
    <description>docker-seedbox e2e fixture indexer</description>
    <link>http://203.0.113.40:8080/</link>
    <caps><categories><category id="2000" name="Movies" /></categories></caps>
  </indexer>
  <indexer id="other-one" configured="true"><title>Other &amp; One</title></indexer>
  <indexer id="bad id!" configured="true"><title>Bad</title></indexer>
</indexers>`;

export const magnetOf = (h = HASH1, dn = 'slow2') => `magnet:?xt=urn:btih:${h}&amp;dn=${dn}&amp;tr=http%3A%2F%2Ftracker.example.org%3A6969%2Fannounce`;
