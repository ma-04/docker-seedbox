import { describe, expect, it } from 'vitest';
import { DEFAULT_SOURCE_URL, resolveBuildInfo } from './buildInfo';

describe('resolveBuildInfo', () => {
  it('defaults to dev and the public repository', () => {
    expect(resolveBuildInfo({})).toEqual({ version: 'dev', sourceUrl: DEFAULT_SOURCE_URL });
    expect(resolveBuildInfo({ VITE_APP_VERSION: ' ', VITE_SOURCE_URL: '' })).toEqual({ version: 'dev', sourceUrl: DEFAULT_SOURCE_URL });
  });
  it('uses the build-provided values', () => {
    expect(resolveBuildInfo({ VITE_APP_VERSION: 'v1.2.3', VITE_SOURCE_URL: 'https://example.org/fork' })).toEqual({ version: 'v1.2.3', sourceUrl: 'https://example.org/fork' });
  });
  it('rejects non-http(s) source links', () => {
    expect(resolveBuildInfo({ VITE_SOURCE_URL: 'javascript:alert(1)' }).sourceUrl).toBe(DEFAULT_SOURCE_URL);
  });
});
