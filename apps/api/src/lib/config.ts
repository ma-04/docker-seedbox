/** Process configuration, read once from the environment. See docs/architecture.md § Environment. */
function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export interface Config {
  appSecret: string;
  gatewaySecret: string;
  vpnControlToken: string;
  appHost: string;
  /** Host of the login portal: AUTH_HOST, or APP_HOST in the single-domain layout (AUTH_HOST empty or equal). */
  authHost: string;
  /** Host that serves /dl/ links: FILES_HOST, or APP_HOST in the single-domain layout (FILES_HOST empty or equal). */
  filesHost: string;
  /** Base URL of the Authelia portal, no trailing slash: https://AUTH_HOST or https://APP_HOST/auth. */
  authPortalUrl: string;
  /** Default base URL of local-destination download links (a destination's publicBaseUrl wins): https://<filesHost>. */
  filesBaseUrl: string;
  /**
   * The web UI's "Log out" target: the Authelia portal's /logout (AUTH_MODE=authelia), or LOGOUT_URL with
   * AUTH_MODE=external (there is no portal then; unset = no logout link).
   */
  logoutUrl: string | null;
  publicScheme: string;
  adminGroup: string;
  dataDir: string;
  downloadsDir: string;
  qbtUrl: string;
  vpnUrl: string;
  port: number;
  logLevel: string;
  /** TEST ONLY (hermetic e2e): tracker-list URLs may be http and on private addresses. Refused without E2E_HERMETIC=1. */
  trackerListAllowPrivate: boolean;
  google: { authUrl: string; tokenUrl: string; apiBaseUrl: string };
  /**
   * Torrent search (optional). null = switched off: the UI hides it and /api/search* answers 404 `search_disabled`.
   * `jackett`: SEARCH_BACKEND=jackett + JACKETT_API_KEY; JACKETT_URL is the origin of Jackett in the VPN namespace.
   */
  search: { backend: 'jackett'; jackettUrl: string; jackettApiKey: string; flaresolverr: boolean } | null;
}

/** Path of the Authelia portal on APP_HOST in the single-domain layout (Authelia: server.address 'tcp://:9091/auth'). */
export const AUTH_SUBPATH = '/auth';

export type HostLayout = Pick<Config, 'appHost' | 'authHost' | 'filesHost' | 'authPortalUrl' | 'filesBaseUrl'>;

/**
 * The hosts layout, by the same rule as the gateway (25-gateway-auth-mode.sh) and Authelia (configuration.yml):
 * AUTH_HOST / FILES_HOST that are empty, or equal to APP_HOST in any case, mean "on APP_HOST" (under /auth/ and /dl/).
 */
export function hostLayout(env: NodeJS.ProcessEnv, scheme: string): HostLayout {
  const norm = (v: string | undefined) => (v ?? '').trim().toLowerCase();
  const appHost = norm(env.APP_HOST) || 'localhost';
  const separate = (v: string | undefined): string | null => { const h = norm(v); return h && h !== appHost ? h : null; };
  const auth = separate(env.AUTH_HOST);
  const files = separate(env.FILES_HOST);
  return {
    appHost,
    authHost: auth ?? appHost,
    filesHost: files ?? appHost,
    authPortalUrl: auth ? `${scheme}://${auth}` : `${scheme}://${appHost}${AUTH_SUBPATH}`,
    filesBaseUrl: `${scheme}://${files ?? appHost}`,
  };
}

/** LOGOUT_URL (AUTH_MODE=external): your SSO's sign-out page. Rendered as a link, so only absolute http(s) URLs. */
function externalLogoutUrl(raw: string | undefined): string | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  let u: URL;
  try { u = new URL(v); } catch { throw new Error(`LOGOUT_URL must be an absolute http(s) URL (got '${v}')`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`LOGOUT_URL must be an absolute http(s) URL (got '${v}')`);
  return u.toString();
}

/** SEARCH_BACKEND / JACKETT_* (docs/configuration.md § Torrent search). Throws on a half-configured backend. */
export function searchConfig(env: NodeJS.ProcessEnv): Config['search'] {
  const backend = (env.SEARCH_BACKEND ?? '').trim().toLowerCase();
  if (!backend || backend === 'off' || backend === 'none') return null;
  if (backend !== 'jackett') throw new Error(`SEARCH_BACKEND must be empty (off) or 'jackett' (got '${backend}')`);
  const key = (env.JACKETT_API_KEY ?? '').trim();
  if (!/^[A-Za-z0-9]{16,128}$/.test(key)) throw new Error('JACKETT_API_KEY must be 16-128 letters/digits (./setup.sh --search generates it)');
  const raw = (env.JACKETT_URL ?? '').trim() || 'http://vpn:9117';
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`JACKETT_URL must be an http(s) origin such as http://vpn:9117 (got '${raw}')`); }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) {
    throw new Error(`JACKETT_URL must be an http(s) origin without path or credentials, such as http://vpn:9117 (got '${raw}')`);
  }
  return { backend: 'jackett', jackettUrl: u.origin, jackettApiKey: key, flaresolverr: env.FLARESOLVERR_ENABLED === '1' };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const appSecret = env.APP_SECRET ?? req('APP_SECRET');
  if (appSecret.length < 32) throw new Error('APP_SECRET must be at least 32 characters');
  const trackerListAllowPrivate = env.TRACKER_LIST_ALLOW_PRIVATE === '1';
  if (trackerListAllowPrivate && env.E2E_HERMETIC !== '1') {
    throw new Error('TRACKER_LIST_ALLOW_PRIVATE is for the hermetic test stack only (it also needs E2E_HERMETIC=1); unset it');
  }
  const publicScheme = env.PUBLIC_SCHEME || 'https';
  const layout = hostLayout(env, publicScheme);
  return {
    appSecret,
    trackerListAllowPrivate,
    gatewaySecret: env.GATEWAY_SECRET ?? req('GATEWAY_SECRET'),
    vpnControlToken: env.VPN_CONTROL_TOKEN ?? req('VPN_CONTROL_TOKEN'),
    ...layout,
    logoutUrl: (env.AUTH_MODE ?? 'authelia').trim().toLowerCase() === 'external' ? externalLogoutUrl(env.LOGOUT_URL) : `${layout.authPortalUrl}/logout`,
    publicScheme,
    adminGroup: env.ADMIN_GROUP ?? 'admins',
    dataDir: env.DATA_DIR ?? '/data',
    downloadsDir: env.DOWNLOADS_DIR ?? '/downloads',
    qbtUrl: env.QBT_URL ?? 'http://vpn:8080',
    vpnUrl: env.VPN_URL ?? 'http://vpn:8000',
    port: Number(env.PORT ?? 3000),
    logLevel: env.LOG_LEVEL ?? 'info',
    search: searchConfig(env),
    google: {
      authUrl: env.GOOGLE_OAUTH_AUTH_URL ?? 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: env.GOOGLE_OAUTH_TOKEN_URL ?? 'https://oauth2.googleapis.com/token',
      apiBaseUrl: env.GOOGLE_API_BASE_URL ?? 'https://www.googleapis.com',
    },
  };
}
