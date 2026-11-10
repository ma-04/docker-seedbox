/** Content-Disposition with an ASCII fallback and an RFC 5987 filename*. */
export function contentDisposition(name: string, inline: boolean): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\%]/g, '_') || 'download';
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
