import { describe, expect, it } from 'vitest';
import { safeHttpUrl } from './url';

describe('safeHttpUrl', () => {
  it('keeps http(s) and relative URLs', () => {
    expect(safeHttpUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(safeHttpUrl('http://example.com')).toBe('http://example.com');
    expect(safeHttpUrl('/dl/file')).toBe('/dl/file');
  });
  it.each(['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:x', 'file:///etc/passwd', null, undefined, ''])('rejects %s', (u) => {
    expect(safeHttpUrl(u)).toBeNull();
  });
});
