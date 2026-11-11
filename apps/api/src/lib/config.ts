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
  authHost: string;
  filesHost: string;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const appSecret = env.APP_SECRET ?? req('APP_SECRET');
  if (appSecret.length < 32) throw new Error('APP_SECRET must be at least 32 characters');
  const trackerListAllowPrivate = env.TRACKER_LIST_ALLOW_PRIVATE === '1';
  if (trackerListAllowPrivate && env.E2E_HERMETIC !== '1') {
    throw new Error('TRACKER_LIST_ALLOW_PRIVATE is for the hermetic test stack only (it also needs E2E_HERMETIC=1); unset it');
  }
  return {
    appSecret,
    trackerListAllowPrivate,
    gatewaySecret: env.GATEWAY_SECRET ?? req('GATEWAY_SECRET'),
    vpnControlToken: env.VPN_CONTROL_TOKEN ?? req('VPN_CONTROL_TOKEN'),
    appHost: env.APP_HOST ?? 'localhost',
    authHost: env.AUTH_HOST ?? 'auth.localhost',
    filesHost: env.FILES_HOST ?? 'files.localhost',
    publicScheme: env.PUBLIC_SCHEME ?? 'https',
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
