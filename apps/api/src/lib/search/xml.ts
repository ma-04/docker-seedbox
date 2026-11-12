/**
 * A deliberately small, DTD-free XML reader for search backend responses (Torznab RSS, Jackett's indexer list).
 *
 * Why not a general XML library: those exist to support what we must never do here. This reader
 *  - refuses every `<!...>` declaration other than comments and CDATA, so there is no DOCTYPE, no internal or external
 *    entity, no XXE and no entity-expansion bomb, by construction (nothing is ever fetched or expanded);
 *  - decodes only the five predefined entities and numeric character references (valid code points only);
 *  - is a single linear pass (indexOf scanning, no backtracking regexes over the input) with hard caps on input size,
 *    nesting depth and node count, so hostile input costs at most O(maxBytes);
 *  - stores attributes in prototype-less objects (`__proto__` is just a name) and rejects duplicate attributes.
 * It is not a validating parser: namespaces are kept as part of the name (`torznab:attr`), and unknown markup that is
 * well-formed is simply returned for the caller to ignore.
 */
export class XmlError extends Error {}

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Concatenated character data directly inside this element (entities decoded, CDATA verbatim). */
  text: string;
}

export interface XmlLimits { maxBytes: number; maxDepth: number; maxNodes: number }
export const DEFAULT_XML_LIMITS: XmlLimits = { maxBytes: 5 * 1024 * 1024, maxDepth: 16, maxNodes: 200_000 };

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[A-Za-z0-9_:.\-]/;
const PREDEFINED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function validCodePoint(cp: number): boolean {
  if (!Number.isInteger(cp) || cp <= 0 || cp > 0x10ffff) return false;
  if (cp >= 0xd800 && cp <= 0xdfff) return false; // surrogates
  if (cp === 0xfffe || cp === 0xffff) return false;
  // XML 1.0 Char: tab, LF, CR and >= 0x20 only.
  return cp === 0x9 || cp === 0xa || cp === 0xd || cp >= 0x20;
}

/** Decode `&...;` references. Anything but the predefined five and valid numeric references is an error. */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  let out = '';
  let i = 0;
  for (;;) {
    const amp = s.indexOf('&', i);
    if (amp < 0) return out + s.slice(i);
    out += s.slice(i, amp);
    const semi = s.indexOf(';', amp);
    if (semi < 0 || semi - amp > 12) throw new XmlError('Malformed entity reference');
    const ref = s.slice(amp + 1, semi);
    if (ref in PREDEFINED && Object.prototype.hasOwnProperty.call(PREDEFINED, ref)) out += PREDEFINED[ref];
    else if (/^#[0-9]{1,7}$/.test(ref) || /^#x[0-9a-fA-F]{1,6}$/.test(ref)) {
      const cp = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!validCodePoint(cp)) throw new XmlError('Invalid character reference');
      out += String.fromCodePoint(cp);
    } else throw new XmlError('Unknown entity (DTD entities are not supported)');
    i = semi + 1;
  }
}

export function parseXml(input: string, limits: XmlLimits = DEFAULT_XML_LIMITS): XmlNode {
  if (Buffer.byteLength(input, 'utf8') > limits.maxBytes) throw new XmlError('Response is too large');
  let s = input;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  if (s.includes('\u0000')) throw new XmlError('NUL character in document');
  const len = s.length;
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  let nodes = 0;
  let pos = 0;

  const text = (raw: string, verbatim = false) => {
    const top = stack[stack.length - 1];
    if (!top) {
      if (raw.trim()) throw new XmlError('Text outside the root element');
      return;
    }
    top.text += verbatim ? raw : decodeEntities(raw);
  };
  const readName = (): string => {
    const start = pos;
    if (pos >= len || !NAME_START.test(s[pos]!)) throw new XmlError('Invalid name');
    pos++;
    while (pos < len && NAME_CHAR.test(s[pos]!)) pos++;
    if (pos - start > 256) throw new XmlError('Name too long');
    return s.slice(start, pos);
  };
  const skipWs = () => { while (pos < len && (s[pos] === ' ' || s[pos] === '\t' || s[pos] === '\n' || s[pos] === '\r')) pos++; };

  while (pos < len) {
    const lt = s.indexOf('<', pos);
    if (lt < 0) { text(s.slice(pos)); pos = len; break; }
    if (lt > pos) text(s.slice(pos, lt));
    pos = lt;
    if (s.startsWith('<?', pos)) {
      const end = s.indexOf('?>', pos + 2);
      if (end < 0) throw new XmlError('Unterminated processing instruction');
      pos = end + 2;
      continue;
    }
    if (s.startsWith('<!--', pos)) {
      const end = s.indexOf('-->', pos + 4);
      if (end < 0) throw new XmlError('Unterminated comment');
      pos = end + 3;
      continue;
    }
    if (s.startsWith('<![CDATA[', pos)) {
      const end = s.indexOf(']]>', pos + 9);
      if (end < 0) throw new XmlError('Unterminated CDATA section');
      text(s.slice(pos + 9, end), true);
      pos = end + 3;
      continue;
    }
    if (s.startsWith('<!', pos)) throw new XmlError('DTDs and declarations are not allowed');
    if (s.startsWith('</', pos)) {
      pos += 2;
      const name = readName();
      skipWs();
      if (s[pos] !== '>') throw new XmlError('Malformed end tag');
      pos++;
      const top = stack.pop();
      if (!top || top.name !== name) throw new XmlError('Mismatched end tag');
      continue;
    }
    // start tag
    pos++;
    const name = readName();
    if (++nodes > limits.maxNodes) throw new XmlError('Too many elements');
    const node: XmlNode = { name, attrs: Object.create(null) as Record<string, string>, children: [], text: '' };
    for (;;) {
      const before = pos;
      skipWs();
      if (pos >= len) throw new XmlError('Unterminated start tag');
      if (s[pos] === '>' || s.startsWith('/>', pos)) break;
      if (pos === before) throw new XmlError('Missing whitespace between attributes');
      const an = readName();
      skipWs();
      if (s[pos] !== '=') throw new XmlError('Attribute without value');
      pos++;
      skipWs();
      const q = s[pos];
      if (q !== '"' && q !== "'") throw new XmlError('Unquoted attribute value');
      const end = s.indexOf(q, pos + 1);
      if (end < 0) throw new XmlError('Unterminated attribute value');
      const raw = s.slice(pos + 1, end);
      if (raw.includes('<')) throw new XmlError('"<" in attribute value');
      if (Object.prototype.hasOwnProperty.call(node.attrs, an)) throw new XmlError('Duplicate attribute');
      node.attrs[an] = decodeEntities(raw);
      pos = end + 1;
    }
    const selfClosing = s[pos] === '/';
    pos += selfClosing ? 2 : 1;
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else if (root) throw new XmlError('More than one root element');
    else root = node;
    if (!selfClosing) {
      stack.push(node);
      if (stack.length > limits.maxDepth) throw new XmlError('Nesting too deep');
    }
  }
  if (stack.length) throw new XmlError('Unclosed element');
  if (!root) throw new XmlError('No root element');
  return root;
}

/** Children named `name`. */
export const kids = (n: XmlNode, name: string): XmlNode[] => n.children.filter((c) => c.name === name);
/** Trimmed text of the first child named `name`, or null. */
export const childText = (n: XmlNode, name: string): string | null => {
  const c = n.children.find((x) => x.name === name);
  return c ? c.text.trim() : null;
};
