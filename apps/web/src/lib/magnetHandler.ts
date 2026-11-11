/** Browser integration: registering this app as the `magnet:` handler, and remembering that we asked. */

export const STORAGE_KEY = 'seedbox.magnetHandler';
export type HandlerState = 'registered' | 'dismissed';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

export function readState(store: Store | null): HandlerState | null {
  try {
    const v = store?.getItem(STORAGE_KEY);
    return v === 'registered' || v === 'dismissed' ? v : null;
  } catch { return null; }
}

export function writeState(store: Store | null, state: HandlerState): void {
  try { store?.setItem(STORAGE_KEY, state); } catch { /* private mode / quota: the banner may show again, harmless */ }
}

/** The big banner shows only until the user has registered or dismissed it once. */
export const shouldShowBanner = (state: HandlerState | null, supported: boolean): boolean => supported && state === null;

export function isSupported(nav: { registerProtocolHandler?: unknown } | undefined, secure: boolean): boolean {
  return !!nav && typeof nav.registerProtocolHandler === 'function' && secure;
}

export const handlerUrl = (origin: string): string => `${origin}/add?magnet=%s`;

/** Throws on SecurityError/SyntaxError. The browser shows its own confirmation. */
export function registerHandler(nav: { registerProtocolHandler: (scheme: string, url: string) => void }, origin: string): void {
  nav.registerProtocolHandler('magnet', handlerUrl(origin));
}
