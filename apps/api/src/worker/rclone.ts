/** rclone invocation: argument/env construction, JSON-log parsing, error redaction and process running. */
import type { ChildProcess } from 'node:child_process';
import { fullRemotePath } from '../lib/destinations.js';
import type { DestinationConfig } from '../lib/types.js';

/** Minimal slice of ChildProcess the runner needs; tests provide a fake. */
export type RcloneProc = Pick<ChildProcess, 'stderr' | 'kill' | 'on'>;
export type SpawnFn = (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => RcloneProc;

export interface RcloneCommand {
  args: string[];
  /** Only PATH, HOME and RCLONE_CONFIG_* — secrets live here, never in args. */
  env: NodeJS.ProcessEnv;
  /** Every secret value present in env, for redaction. */
  secrets: string[];
}

/**
 * Build the `rclone copy` command for a remote (gdrive/s3) destination. `src` is a directory or a single file.
 * `opts.gdriveFolderId`: Drive folder the files go directly into. The worker resolves it first (under a mutex) so
 * rclone never creates parent folders itself (two concurrent uploads would create duplicate same-named folders);
 * it becomes rclone's `root_folder_id` and the target is `DST:`.
 */
export function buildRcloneCommand(config: DestinationConfig, src: string, remotePath: string, opts: { gdriveFolderId?: string } = {}): RcloneCommand {
  const env: NodeJS.ProcessEnv = {};
  const secrets: string[] = [];
  const set = (k: string, v: string, secret = false) => {
    env[`RCLONE_CONFIG_DST_${k}`] = v;
    if (secret && v) secrets.push(v);
  };
  const extra: string[] = [];
  let target: string;
  if (config.type === 'gdrive') {
    set('TYPE', 'drive');
    set('CLIENT_ID', config.clientId);
    set('CLIENT_SECRET', config.clientSecret, true);
    set('SCOPE', 'drive.file');
    set('ROOT_FOLDER_ID', opts.gdriveFolderId ?? config.rootFolderId);
    set('TOKEN', JSON.stringify({ access_token: '', token_type: 'Bearer', refresh_token: config.refreshToken, expiry: '2000-01-01T00:00:00Z' }), true);
    secrets.push(config.refreshToken);
    target = opts.gdriveFolderId ? 'DST:' : `DST:${remotePath}`;
  } else if (config.type === 's3') {
    set('TYPE', 's3');
    set('PROVIDER', 'Other');
    set('ENDPOINT', config.endpoint);
    set('REGION', config.region);
    set('ACCESS_KEY_ID', config.accessKeyId, true);
    set('SECRET_ACCESS_KEY', config.secretAccessKey, true);
    set('FORCE_PATH_STYLE', String(config.forcePathStyle ?? true));
    target = `DST:${config.bucket}/${fullRemotePath(config, remotePath)}`;
    extra.push('--s3-no-check-bucket');
  } else {
    throw new Error(`rclone is not used for ${config.type} destinations`);
  }
  return { args: rcloneArgs(src, target, extra), env, secrets: secrets.filter(Boolean) };
}

/** rclone/S3 errors that mean "the server rejected our credentials". */
export const S3_AUTH_ERROR = /InvalidAccessKeyId|SignatureDoesNotMatch|AccessDenied|InvalidToken|ExpiredToken|AuthorizationHeaderMalformed|StatusCode:?\s*40[13]\b|\b40[13] (?:Forbidden|Unauthorized)/i;

/**
 * Cheap read-only call against the bucket root (same env/secrets as the copy), used after a failed S3 copy to find out
 * whether the real cause is rejected credentials. rclone's own copy error is misleading in that case: with bad
 * credentials the HEAD of the destination path fails with 403 and rclone >= 1.7x reports "is a file not a directory".
 * `lsd` lists one level of prefixes only, so it is cheap on large buckets.
 */
export function s3ProbeCommand(cmd: RcloneCommand, bucket: string): RcloneCommand {
  return {
    ...cmd,
    args: ['lsd', `DST:${bucket}`, '--config', '', '--use-json-log', '--retries', '1', '--low-level-retries', '1', '--s3-no-check-bucket'],
  };
}

export function rcloneArgs(src: string, target: string, extra: string[] = []): string[] {
  return [
    'copy', src, target,
    '--config', '', // never read or write an on-disk config (rclone would try to persist the refreshed token)
    '--use-json-log', '--stats', '1s', '--stats-log-level', 'NOTICE',
    '--transfers', '4', '--retries', '3', '--low-level-retries', '10', '-v',
    ...extra,
  ];
}

export interface RcloneStats { bytes: number; totalBytes: number; speed: number }

/** Parse one stderr line; returns stats when it is a JSON log line carrying a `stats` object. */
export function parseStatsLine(line: string): RcloneStats | null {
  if (line[0] !== '{') return null;
  try {
    const o = JSON.parse(line) as { stats?: { bytes?: number; totalBytes?: number; speed?: number } };
    if (!o.stats || typeof o.stats.bytes !== 'number') return null;
    return { bytes: o.stats.bytes, totalBytes: o.stats.totalBytes ?? 0, speed: o.stats.speed ?? 0 };
  } catch { return null; }
}

/** Strip anything that looks like a credential, plus the exact secret values we handed to rclone. */
export function redact(text: string, secrets: string[] = []): string {
  let out = text;
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join('[redacted]');
  return out
    .replace(/Bearer\s+\S+/g, 'Bearer [redacted]')
    .replace(/("?(?:refresh_token|access_token|client_secret|secret_access_key|access_key_id|password|authorization)"?\s*[:=]\s*)("[^"]*"|\S+)/gi, '$1[redacted]')
    .replace(/\b[A-Za-z0-9_\-+=]{32,}\b/g, '[redacted]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b/g, '[redacted]');
}

export interface RunOptions {
  spawn: SpawnFn;
  bin: string;
  cmd: RcloneCommand;
  signal?: AbortSignal;
  onStats: (s: RcloneStats) => void;
  /** Called with the process so the caller can kill it on shutdown. */
  onProc?: (p: RcloneProc) => void;
  /** After an abort: SIGTERM first, SIGKILL if the process is still alive after this long. Default 10 s. */
  killGraceMs?: number;
  /** Fail (and kill rclone) when `bytes` did not increase for this long. Default 30 min; 0 disables. */
  stallMs?: number;
}

export class RcloneError extends Error {}
export class RcloneAborted extends Error { constructor() { super('aborted'); } }

/** Run rclone to completion. Resolves on exit 0; rejects with RcloneError (redacted tail of the log) otherwise. */
export function runRclone(o: RunOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', ...o.cmd.env };
    if (o.signal?.aborted) return reject(new RcloneAborted());
    const proc = o.spawn(o.bin, o.cmd.args, { env });
    o.onProc?.(proc);
    const errors: string[] = [];
    const tail: string[] = [];
    let buf = '';
    let done = false;
    const finish = (fn: () => void) => { if (!done) { done = true; if (stallTimer) clearTimeout(stallTimer); o.signal?.removeEventListener('abort', onAbort); fn(); } };
    let exited = false;
    let stallTimer: NodeJS.Timeout | undefined;
    const kill = () => {
      proc.kill('SIGTERM');
      const t = setTimeout(() => { if (!exited) proc.kill('SIGKILL'); }, o.killGraceMs ?? 10_000);
      t.unref?.();
    };
    const onAbort = () => { kill(); finish(() => reject(new RcloneAborted())); };
    o.signal?.addEventListener('abort', onAbort, { once: true });
    const stallMs = o.stallMs ?? 30 * 60_000;
    let lastBytes = -1;
    const armStall = () => {
      if (stallMs <= 0) return;
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        kill();
        finish(() => reject(new RcloneError(`rclone stalled: no transfer progress for ${Math.round(stallMs / 60_000)} minutes`)));
      }, stallMs);
      stallTimer.unref?.();
    };
    armStall();

    const onLine = (line: string) => {
      if (!line.trim()) return;
      const stats = parseStatsLine(line);
      if (stats) {
        if (stats.bytes !== lastBytes) { lastBytes = stats.bytes; armStall(); }
        return o.onStats(stats);
      }
      let msg = line;
      let level = '';
      if (line[0] === '{') {
        try { const j = JSON.parse(line) as { msg?: string; level?: string }; msg = j.msg ?? line; level = j.level ?? ''; } catch { /* plain text */ }
      }
      if (level === 'error' || level === 'critical' || level === 'fatal') errors.push(msg);
      else if (level !== 'info' && level !== 'debug' && level !== 'warning') tail.push(msg); // plain-text stderr
      if (tail.length > 20) tail.shift();
      if (errors.length > 20) errors.shift();
    };
    proc.stderr?.on('data', (chunk: Buffer | string) => {
      buf += chunk.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    proc.on('exit', () => { exited = true; });
    proc.on('error', (err) => finish(() => reject(new RcloneError(`Could not run rclone: ${redact(err.message, o.cmd.secrets)}`))));
    proc.on('close', (code, signal) => {
      exited = true;
      if (buf) onLine(buf);
      finish(() => {
        if (code === 0) return resolve();
        const lines = (errors.length ? errors : tail).slice(-3).join(' | ');
        const detail = redact(lines, o.cmd.secrets).slice(0, 600);
        reject(new RcloneError(`rclone failed (${signal ? `signal ${signal}` : `exit ${code}`})${detail ? `: ${detail}` : ''}`));
      });
    });
  });
}
