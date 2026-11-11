/** Content-Disposition with an ASCII fallback and an RFC 5987 filename*. */
/** Always `attachment`: there is deliberately no inline mode (stored XSS on the proxy origin). */
export function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\%]/g, '_') || 'download';
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// Active content types are never served with their real type, even as attachments.
const ACTIVE_MIME = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|[^;]*\+xml|(application|text)\/(x-)?javascript|text\/ecmascript|application\/ecmascript)\s*(;|$)/i;

export function safeContentType(mime: string | undefined): string {
  const m = (mime ?? '').trim();
  return !m || ACTIVE_MIME.test(m) ? 'application/octet-stream' : m;
}
