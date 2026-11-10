# drive-proxy

A Cloudflare Worker that serves files from the shared Google Drive destination through signed links. Users never need a Google account and the Drive credentials never leave the Worker. Zero runtime dependencies.

## How it works

The seedbox uploads into one Drive account under `ROOT_FOLDER_ID` as `<userSlug>/<torrentName>/<files...>` and hands out links like:

```
https://drive.example.com/<userSlug>/<torrentName>/<sub/dir/file.ext>?exp=<unix>&sig=<hex>
```

- The path is URL-encoded per segment. Decoded, it is the canonical path (`/alice/My Torrent/a b.mkv`).
- `sig = hex(HMAC-SHA256(SIGNING_KEY, path + "\n" + exp))`, 64 lowercase hex chars. `exp` is unix seconds (1-12 digits); `0` never expires. See `docs/architecture.md` (Links) for the shared contract and test vectors.
- `?inline=1` (not signed) switches `Content-Disposition` from `attachment` to `inline`.

Behaviour: only `GET`/`HEAD` (others 405). The signature is verified before any Google call (bad or missing 403, expired 410). The path is then resolved folder by folder with `files.list` (cached with the Cache API, `CACHE_TTL_SECONDS`, negative results at most 30 s) and the file is streamed with `Range` support. Anything else (`/`, directories, Google Docs, malformed or traversal paths) is a 404. There is never a directory listing. `/robots.txt` disallows everything. Drive quota errors become 429 with `Retry-After`; other upstream failures become 502 with no upstream details.

## Deploy

From the repo root (`npm install` already done):

```sh
cd apps/drive-proxy
npx wrangler login
npx wrangler deploy
npx wrangler secret put GDRIVE_CLIENT_ID
npx wrangler secret put GDRIVE_CLIENT_SECRET
npx wrangler secret put GDRIVE_REFRESH_TOKEN
npx wrangler secret put SIGNING_KEY
```

Then set `ROOT_FOLDER_ID` under `[vars]` in `wrangler.toml` and run `npx wrangler deploy` again.

Where the values come from:

| Name | Value |
|---|---|
| `GDRIVE_CLIENT_ID`, `GDRIVE_CLIENT_SECRET`, `GDRIVE_REFRESH_TOKEN` | The same Google OAuth client and refresh token the shared Drive destination uses, e.g. from an rclone `drive` remote (`rclone config show <remote>`: `client_id`, `client_secret`, and `refresh_token` inside the `token` JSON). The account must be able to read the root folder. |
| `SIGNING_KEY` | Must equal the destination's "proxy signing key" in the seedbox admin UI. |
| `ROOT_FOLDER_ID` | The destination's root folder id (the id in the Drive folder URL). |

Optional vars: `ALLOWED_ORIGINS` (comma separated origins or `*`, default no CORS headers), `CACHE_TTL_SECONDS` (default 300).

Finally, in the seedbox admin UI open the shared Google Drive destination and set its **proxy base URL** to the Worker URL (`https://seedbox-drive-proxy.<account>.workers.dev` or your custom domain, no trailing slash). Use the destination's test button to check.

### Custom domain

Add `drive.example.com` under Workers & Pages > seedbox-drive-proxy > Settings > Domains & Routes (the zone must be on your Cloudflare account), or uncomment a `routes` entry in `wrangler.toml` and redeploy. Use that URL as the proxy base URL.

## Local development

```sh
cp .dev.vars.example .dev.vars   # fill in placeholders; .dev.vars is gitignored
npx wrangler dev
npm test        # vitest, fully mocked, no network
npm run typecheck
```

## Limits

- Google download quotas apply to the shared account (per-file and daily). When Drive refuses, clients get 429 with `Retry-After`.
- Workers stream responses with no size limit, but subrequest, CPU time and connection limits of your Workers plan apply. Files are never buffered.
- Drive's `If-Range` uses its own validators. The Worker honours `If-Range` when it equals the Worker's own `ETag`/`Last-Modified`, otherwise it sends the whole file (200).
- Google Docs/Sheets/Slides are not served.
- Duplicate names in one folder resolve to the most recently modified item.

## Security notes

- Links are bearer tokens: anyone holding one can download that file until it expires. Choose link TTLs accordingly.
- Rotate `SIGNING_KEY` (here and in the admin UI) to revoke every outstanding link at once.
- Drive credentials exist only as Worker secrets; responses never contain upstream error bodies or credentials.
- Responses are `Cache-Control: private, no-store`, `X-Robots-Tag: noindex`, `nosniff`, `Referrer-Policy: no-referrer`.
