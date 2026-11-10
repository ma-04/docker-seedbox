import { z } from 'zod';
import { mergeConfig } from '../lib/destinations.js';
import { parseHttpUrl } from '../lib/netguard.js';
import { SECRET_FIELDS, type DestinationConfig, type DestinationType } from '../lib/types.js';
import { parse, validation } from './errors.js';

/** http(s) only, no embedded credentials (blocks javascript:/data: hrefs and user:pass@host tricks). */
const url = z.string().max(2048).superRefine((v, ctx) => {
  try { parseHttpUrl(v); } catch (e) { ctx.addIssue({ code: 'custom', message: (e as Error).message }); }
});
const ttl = z.number().int().min(0).max(3_153_600_000).optional();

const subdir = z.string().max(300).optional().refine(
  (s) => s === undefined || s.replace(/^\/+|\/+$/g, '').split('/').every((p) => p !== '' && p !== '.' && p !== '..' && !p.includes('\\') && !p.includes('\0')) || s.replace(/\//g, '') === '',
  'subdir must not contain "." / ".." segments');

const schemas = {
  s3: z.object({
    endpoint: url,
    region: z.string().min(1).max(64).default('us-east-1'),
    accessKeyId: z.string().min(1).max(256),
    secretAccessKey: z.string().min(1).max(512),
    bucket: z.string().min(1).max(256),
    prefix: z.string().max(512).optional(),
    forcePathStyle: z.boolean().optional(),
    publicBaseUrl: url.optional(),
    linkTtlSeconds: ttl,
  }),
  gdrive: z.object({
    clientId: z.string().min(1).max(512),
    clientSecret: z.string().min(1).max(512),
    refreshToken: z.string().min(1).max(2048),
    rootFolderId: z.string().min(1).max(256),
    sharing: z.enum(['none', 'anyone', 'user']).default('none'),
    proxyBaseUrl: url.optional(),
    proxySigningKey: z.string().min(1).max(512).optional(),
    linkTtlSeconds: ttl,
  }),
  local: z.object({ subdir, publicBaseUrl: url.optional(), linkTtlSeconds: ttl }),
} as const;

/** Drop empty strings (UI forms send '' for blank optional fields). */
export function stripEmpty(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== ''));
}

/** Validate a full config for `type`; unknown keys are dropped. */
export function validateConfig(type: DestinationType, raw: Record<string, unknown>): DestinationConfig {
  const data = parse(schemas[type], stripEmpty(raw)) as Record<string, unknown>;
  for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
  if (type === 's3' && typeof data.endpoint !== 'string') throw validation('endpoint is required');
  return { ...data, type } as unknown as DestinationConfig;
}

/** Apply a PATCH of config fields: '' clears an optional field, MASK/'' on a secret keeps it. */
export function applyConfigPatch(existing: DestinationConfig, patch: Record<string, unknown>): DestinationConfig {
  const secrets = SECRET_FIELDS[existing.type] as readonly string[];
  const clear: string[] = [];
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'type') continue;
    if (v === '') { if (!secrets.includes(k)) clear.push(k); continue; }
    clean[k] = v;
  }
  const merged = mergeConfig(existing, clean as Partial<typeof existing>) as unknown as Record<string, unknown>;
  for (const k of clear) delete merged[k];
  return validateConfig(existing.type, merged);
}
