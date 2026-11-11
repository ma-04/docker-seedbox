/** Build-time info for the footer (AGPL: users of the running service can find the corresponding source). */
export const DEFAULT_SOURCE_URL = 'https://github.com/ma-04/docker-seedbox';

export interface BuildInfo { version: string; sourceUrl: string }

export function resolveBuildInfo(env: { VITE_APP_VERSION?: string; VITE_SOURCE_URL?: string }): BuildInfo {
  const version = (env.VITE_APP_VERSION ?? '').trim() || 'dev';
  const raw = (env.VITE_SOURCE_URL ?? '').trim();
  // Only ever render an http(s) link, whatever the build was given.
  const sourceUrl = /^https?:\/\//i.test(raw) ? raw : DEFAULT_SOURCE_URL;
  return { version, sourceUrl };
}

export const buildInfo = resolveBuildInfo(import.meta.env as Record<string, string | undefined>);
