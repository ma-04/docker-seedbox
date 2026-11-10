export interface Env {
  GDRIVE_CLIENT_ID: string;
  GDRIVE_CLIENT_SECRET: string;
  GDRIVE_REFRESH_TOKEN: string;
  SIGNING_KEY: string;
  ROOT_FOLDER_ID: string;
  ALLOWED_ORIGINS?: string;
  CACHE_TTL_SECONDS?: string;
}

/** An error that maps directly to an HTTP response with a generic body. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}
