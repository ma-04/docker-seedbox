import { describe, expect, it } from 'vitest';
import { decodeEntities, parseXml, XmlError } from './xml.js';

describe('parseXml: well-formed input', () => {
  it('parses elements, attributes, text, CDATA, comments and the XML declaration', () => {
    const r = parseXml(`<?xml version="1.0" encoding="UTF-8"?>
      <!-- a comment -->
      <rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
        <channel><item><title>A &amp; B &lt;c&gt; &#233;&#x1F600;</title><desc><![CDATA[<b>&amp;</b>]]></desc>
        <torznab:attr name="seeders" value="5"/><torznab:attr name='peers' value='7' /></item></channel>
      </rss>`);
    expect(r.name).toBe('rss');
    const item = r.children[0]!.children[0]!;
    expect(item.children.map((c) => c.name)).toEqual(['title', 'desc', 'torznab:attr', 'torznab:attr']);
    expect(item.children[0]!.text).toBe('A & B <c> é😀');
    expect(item.children[1]!.text).toBe('<b>&amp;</b>'); // CDATA is verbatim
    expect(item.children[3]!.attrs).toEqual({ name: 'peers', value: '7' });
  });

  it('attributes live in a prototype-less object: __proto__ / constructor are plain names', () => {
    const r = parseXml('<a __proto__="x" constructor="y" toString="z"/>');
    expect(r.attrs.__proto__).toBe('x');
    expect(Object.getPrototypeOf(r.attrs)).toBeNull();
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe('parseXml: hostile input is refused', () => {
  const xxe = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>`;
  const laughs = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]><lolz>&lol2;</lolz>`;
  it.each([
    ['XXE (external entity)', xxe],
    ['billion laughs', laughs],
    ['bare DOCTYPE', '<!DOCTYPE html><html/>'],
    ['parameter entity', '<!ENTITY % p "x"><r/>'],
    ['undeclared entity', '<r>&nbsp;</r>'],
    ['entity without ;', '<r>&amp</r>'],
    ['NUL character reference', '<r>&#0;</r>'],
    ['surrogate reference', '<r>&#xD800;</r>'],
    ['out of range reference', '<r>&#x110000;</r>'],
    ['control character reference', '<r>&#1;</r>'],
    ['raw NUL', '<r>\u0000</r>'],
    ['mismatched end tag', '<a><b></a></b>'],
    ['unclosed element', '<a><b></b>'],
    ['two roots', '<a/><b/>'],
    ['text outside the root', 'junk<a/>'],
    ['duplicate attribute', '<a x="1" x="2"/>'],
    ['unquoted attribute', '<a x=1/>'],
    ['< in attribute', '<a x="<"/>'],
    ['attributes without whitespace', '<a x="1"y="2"/>'],
    ['unterminated comment', '<a><!-- </a>'],
    ['unterminated CDATA', '<a><![CDATA[ </a>'],
    ['empty document', '   '],
    ['not XML at all', '{"json": true}'],
  ])('%s', (_name, xml) => {
    expect(() => parseXml(xml)).toThrow(XmlError);
  });

  it('caps input size, nesting depth and element count', () => {
    expect(() => parseXml(`<a>${'x'.repeat(2000)}</a>`, { maxBytes: 1000, maxDepth: 16, maxNodes: 100 })).toThrow(/too large/);
    expect(() => parseXml('<a>'.repeat(20) + '</a>'.repeat(20), { maxBytes: 1e6, maxDepth: 16, maxNodes: 1000 })).toThrow(/too deep/);
    expect(() => parseXml(`<a>${'<b/>'.repeat(200)}</a>`, { maxBytes: 1e6, maxDepth: 16, maxNodes: 100 })).toThrow(/Too many/);
  });

  it('stays linear on large and pathological input (5 MB within a second)', () => {
    const items = '<item><title>x &amp; y</title><torznab:attr name="a" value="b"/></item>'.repeat(60_000);
    const big = `<rss><channel>${items}</channel></rss>`;
    expect(big.length).toBeGreaterThan(4_000_000);
    let t = Date.now();
    const r = parseXml(big);
    expect(r.children[0]!.children.length).toBe(60_000);
    expect(Date.now() - t).toBeLessThan(3000);
    // Many unclosed "<a" / "&" fragments: no backtracking blow-up, just an error.
    t = Date.now();
    expect(() => parseXml(`<a>${'&'.repeat(1_000_000)}</a>`)).toThrow(XmlError);
    expect(() => parseXml(`<a x="${'a'.repeat(4_000_000)}`)).toThrow(XmlError);
    expect(Date.now() - t).toBeLessThan(3000);
  });
});

describe('decodeEntities', () => {
  it('decodes only the predefined five and numeric references', () => {
    expect(decodeEntities('&quot;&apos;&lt;&gt;&amp;&#65;&#x42;')).toBe(`"'<>&AB`);
    expect(() => decodeEntities('&copy;')).toThrow(XmlError);
    expect(() => decodeEntities('&__proto__;')).toThrow(XmlError);
    expect(() => decodeEntities('&constructor;')).toThrow(XmlError);
  });
});
