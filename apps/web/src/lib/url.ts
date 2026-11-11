/** Returns the URL only if it is plain http(s); anything else (javascript:, data:, ...) -> null. */
export function safeHttpUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const p = new URL(u, 'http://localhost');
    return p.protocol === 'https:' || p.protocol === 'http:' ? u : null;
  } catch { return null; }
}
