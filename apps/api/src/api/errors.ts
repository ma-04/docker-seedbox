import { z } from 'zod';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const unauthorized = (m = 'Unauthorized') => new ApiError(401, 'unauthorized', m);
export const forbidden = (m = 'Forbidden') => new ApiError(403, 'forbidden', m);
export const notFound = (what = 'Resource') => new ApiError(404, 'not_found', `${what} not found`);
export const validation = (m: string) => new ApiError(400, 'validation', m);
export const conflict = (m: string) => new ApiError(409, 'conflict', m);
export const limitExceeded = (m: string, status = 429) => new ApiError(status, 'limit_exceeded', m);

/** Validate with zod; throws a 400 `validation` ApiError with the first issue. */
export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const i = r.error.issues[0]!;
  const where = i.path.length ? `${i.path.join('.')}: ` : '';
  throw validation(`${where}${i.message}`);
}

export const idParam = z.coerce.number().int().positive();
