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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const appSecret = env.APP_SECRET ?? req('APP_SECRET');
  if (appSecret.length < 32) throw new Error('APP_SECRET must be at least 32 characters');
  const trackerListAllowPrivate = env.TRACKER_LIST_ALLOW_PRIVATE === '1';
  if (trackerListAllowPrivate && env.E2E_HERMETIC !== '1') {
    throw new Error('TRACKER_LIST_ALLOW_PRIVATE is for the hermetic test stack only (it also needs E2E_HERMETIC=1); unset it');
  }
  const publicScheme = env.PUBLIC_SCHEME || 'https';
  return {
    appSecret,
    trackerListAllowPrivate,
    gatewaySecret: env.GATEWAY_SECRET ?? req('GATEWAY_SECRET'),
    vpnControlToken: env.VPN_CONTROL_TOKEN ?? req('VPN_CONTROL_TOKEN'),
    ...hostLayout(env, publicScheme),
    publicScheme,
    adminGroup: env.ADMIN_GROUP ?? 'admins',
    dataDir: env.DATA_DIR ?? '/data',
    downloadsDir: env.DOWNLOADS_DIR ?? '/downloads',
    qbtUrl: env.QBT_URL ?? 'http://vpn:8080',
    vpnUrl: env.VPN_URL ?? 'http://vpn:8000',
    port: Number(env.PORT ?? 3000),
    logLevel: env.LOG_LEVEL ?? 'info',
    google: {
      authUrl: env.GOOGLE_OAUTH_AUTH_URL ?? 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: env.GOOGLE_OAUTH_TOKEN_URL ?? 'https://oauth2.googleapis.com/token',
      apiBaseUrl: env.GOOGLE_API_BASE_URL ?? 'https://www.googleapis.com',
    },
  };
}
