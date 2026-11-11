import { describe, expect, it, vi } from 'vitest';
import { STORAGE_KEY, handlerUrl, isSupported, readState, registerHandler, shouldShowBanner, writeState } from './magnetHandler';

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe('banner state', () => {
  it('starts empty, persists registered/dismissed, ignores junk', () => {
    const s = memory();
    expect(readState(s)).toBeNull();
    writeState(s, 'dismissed');
    expect(readState(s)).toBe('dismissed');
    writeState(s, 'registered');
    expect(readState(s)).toBe('registered');
    s.setItem(STORAGE_KEY, 'nonsense');
    expect(readState(s)).toBeNull();
  });
  it('survives unavailable or throwing storage', () => {
    const bad = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(readState(bad)).toBeNull();
    expect(() => writeState(bad, 'registered')).not.toThrow();
    expect(readState(null)).toBeNull();
  });
  it('shows the banner only first time and only when supported', () => {
    expect(shouldShowBanner(null, true)).toBe(true);
    expect(shouldShowBanner('registered', true)).toBe(false);
    expect(shouldShowBanner('dismissed', true)).toBe(false);
    expect(shouldShowBanner(null, false)).toBe(false);
  });
});

describe('registration', () => {
  it('detects support (API present and secure context)', () => {
    expect(isSupported({ registerProtocolHandler: () => {} }, true)).toBe(true);
    expect(isSupported({ registerProtocolHandler: () => {} }, false)).toBe(false);
    expect(isSupported({}, true)).toBe(false);
    expect(isSupported(undefined, true)).toBe(false);
  });
  it('registers magnet with an absolute same-origin template', () => {
    const fn = vi.fn();
    registerHandler({ registerProtocolHandler: fn }, 'https://seedbox.example.com');
    expect(fn).toHaveBeenCalledWith('magnet', 'https://seedbox.example.com/add?magnet=%s');
    expect(handlerUrl('https://x.test')).toBe('https://x.test/add?magnet=%s');
  });
});
