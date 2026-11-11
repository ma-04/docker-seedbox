/**
 * Logger policy for the API (docs/architecture.md § Logging). Signed download links carry their credentials in the query
 * string (`?exp=&sig=`), magnet links can carry private-tracker passkeys, and request headers carry the gateway secret and
 * user cookies. None of those may reach the log at any level:
 *  - the `req` serializer logs method, path (query stripped), host and remote address only;
 *  - `redact` censors the sensitive headers/body fields should anyone ever log a whole request or body.
 */
import type { FastifyBaseLogger, FastifyRequest } from 'fastify';

export const stripQuery = (url: string | undefined): string | undefined => (url === undefined ? url : url.split('?')[0]!.split('#')[0]);

export const REDACT_PATHS = [
  'req.headers.authorization', 'req.headers.cookie', 'req.headers["x-gateway-secret"]', 'req.headers["proxy-authorization"]',
  'headers.authorization', 'headers.cookie', 'headers["x-gateway-secret"]', 'headers["proxy-authorization"]',
  'res.headers["set-cookie"]',
  'body.magnet', 'req.body.magnet', 'magnet', 'req.query', 'query',
];

export function loggerOptions(base: boolean | object | undefined): object | false {
  if (!base) return false;
  const given = base === true ? {} : (base as Record<string, unknown>);
  return {
    ...given,
    serializers: {
      ...(given.serializers as object | undefined),
      req: (req: FastifyRequest) => ({ method: req.method, url: stripQuery(req.url), host: req.headers?.host, remoteAddress: req.ip }),
    },
    redact: { paths: [...REDACT_PATHS, ...(((given.redact as { paths?: string[] } | undefined)?.paths) ?? [])], censor: '[redacted]' },
  };
}

export type { FastifyBaseLogger };
