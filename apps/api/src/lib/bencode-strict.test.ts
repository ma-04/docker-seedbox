import { describe, expect, it } from 'vitest';
import { assertCanonical, BencodeError, decodeStrict, dictGet, encodeCanonical, MAX_DEPTH, MAX_ELEMENTS, type DictNode } from './bencode-strict.js';
import { bd, bdRaw, bi, bl, bs } from './torrent-fixtures.js';

const dec = (s: string | Buffer, max?: number) => decodeStrict(Buffer.isBuffer(s) ? s : Buffer.from(s, 'latin1'), max);
const nest = (n: number) => Buffer.from('l'.repeat(n) + 'e'.repeat(n));

describe('decodeStrict accepts canonical input and round-trips byte for byte', () => {
  it.each(['i0e', 'i-5e', 'i123e', '0:', '4:spam', 'le', 'de', 'l4:spami3ee', 'd3:bar4:spam3:fooi42ee', 'd1:ad1:bli1eeee'])('%s', (s) => {
    const b = Buffer.from(s, 'latin1');
    const n = dec(b);
    expect(encodeCanonical(n).equals(b)).toBe(true);
    expect(() => assertCanonical(b, n)).not.toThrow();
  });

  it('exposes the exact raw byte range of each top-level value', () => {
    const info = bd({ a: bi(1), b: bs('x') });
    const f = bd({ announce: bs('http://t/'), info });
    const root = dec(f) as DictNode;
    const v = dictGet(root, 'info')!;
    expect(f.subarray(v.start, v.end).equals(info)).toBe(true);
  });
});

describe('decodeStrict rejects every non-canonical or malformed construct', () => {
  const cases: [string, string | Buffer][] = [
    ['empty input', ''],
    ['duplicate key at the root', 'd1:ai1e1:ai2ee'],
    ['duplicate key inside a nested dict', 'd1:ad1:bi1e1:bi2eee'],
    ['unsorted keys at the root', 'd1:bi1e1:ai2ee'],
    ['unsorted keys in a nested dict', 'd1:ad1:bi1e1:ai2eee'],
    ['unsorted keys inside a list of dicts', 'ld1:bi1e1:ai2eee'],
    ['keys sorted by character not by raw bytes', Buffer.concat([Buffer.from('d'), bs(Buffer.from([0xe9])), bi(1), bs('z'), bi(2), Buffer.from('e')])],
    ['non-string dict key (int)', 'di1ei2ee'],
    ['non-string dict key (list)', 'dlei1ee'],
    ['integer with a leading zero', 'i01e'],
    ['integer with several leading zeros', 'i007e'],
    ['negative zero', 'i-0e'],
    ['negative with leading zero', 'i-01e'],
    ['empty integer', 'ie'],
    ['sign-only integer', 'i-e'],
    ['integer with a non-digit', 'i1x2e'],
    ['integer with a plus sign', 'i+1e'],
    ['integer with a space', 'i 1e'],
    ['unterminated integer', 'i12'],
    ['absurdly long integer', `i${'9'.repeat(40)}e`],
    ['string length with a leading zero', '04:spam'],
    ['string length with leading zeros', '00:'],
    ['string longer than the buffer', '5:spam'],
    ['huge string length', '99999999999:x'],
    ['negative string length', '-1:a'],
    ['missing colon', '4spam'],
    ['trailing junk after a dict', 'de-garbage'],
    ['a second root value', 'i1ei2e'],
    ['trailing newline', 'i1e\n'],
    ['unterminated list', 'l4:spam'],
    ['unterminated dict', 'd1:ai1e'],
    ['dict key without a value', 'd1:ae'],
    ['invalid token', 'x'],
    ['nesting deeper than the cap', nest(MAX_DEPTH + 1)],
    ['very deep nesting', nest(5000)],
  ];
  it.each(cases)('%s', (_name, input) => {
    expect(() => dec(input)).toThrow(BencodeError);
  });

  it('accepts nesting exactly at the cap', () => {
    expect(() => dec(nest(MAX_DEPTH))).not.toThrow();
  });

  it('enforces the size cap', () => {
    expect(() => dec('4:spam', 5)).toThrow(/too large/);
    expect(() => dec('4:spam', 6)).not.toThrow();
  });

  it('enforces the element-count cap', () => {
    // MAX_ELEMENTS + 1 integers in one list: 3 bytes each is ~6 MB, so lift the byte cap for this test.
    const body = Buffer.concat([Buffer.from('l'), Buffer.from('i1e'.repeat(MAX_ELEMENTS)), Buffer.from('e')]);
    expect(() => decodeStrict(body, body.length)).toThrow(/too many elements/);
  });

  it('a lenient decoder would accept these, the strict one must not (duplicate info key)', () => {
    const f = bdRaw(['info', bd({ a: bi(1) })], ['info', bd({ a: bi(2) })]);
    expect(() => dec(f)).toThrow(/ascending/);
  });
});
