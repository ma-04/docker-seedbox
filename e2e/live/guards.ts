// Pure guard functions for the destructive steps of the live suite (no env, no I/O: unit-tested in 00-guards.spec.ts).
// Rule: only ever delete something this run itself created, and prove it against the run-state file right before deleting.

/** Mirrors apps/api/src/lib/types.ts `userSlug` + destinations.ts `userDirName` (`<slug>-<userId>`). */
export const userSlug = (username: string): string => username.toLowerCase().replace(/[^a-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 64) || 'user';
export const userDirName = (user: { id: number; username: string }): string => `${userSlug(user.username)}-${user.id}`;

/** `<userDir>/<torrent name> [<hash8>]`, exactly the shape the app gives a job folder of a SHARED destination. */
export const RUN_FOLDER_RE = /^[a-z0-9._-]+-\d+\/[A-Za-z0-9._-]+ \[[0-9a-f]{8}\]$/;

/**
 * The folder (relative to the destination root) the app will create for this user's job. Only plain ASCII torrent names
 * (the official ISOs) are supported: anything else could be sanitised differently by the app, so it is refused rather
 * than guessed.
 */
export function runFolderFor(user: { id: number; username: string }, infohash: string, torrentName: string): string {
  if (!/^[0-9a-f]{40}$/i.test(infohash)) throw new Error(`bad infohash ${infohash}`);
  if (!/^[A-Za-z0-9._-]+$/.test(torrentName) || /^\.+$/.test(torrentName)) throw new Error(`refusing to record a folder for the unusual name ${JSON.stringify(torrentName)}`);
  const rel = `${userDirName(user)}/${torrentName} [${infohash.slice(0, 8).toLowerCase()}]`;
  assertFolderShape(rel);
  return rel;
}

export function assertFolderShape(rel: string): void {
  if (!RUN_FOLDER_RE.test(rel) || rel.split('/').some((s) => s === '' || s === '.' || s === '..') || /[*?[\]\\]/.test(rel.replace(/ \[[0-9a-f]{8}\]$/, ''))) {
    throw new Error(`not a run folder: ${JSON.stringify(rel)}`);
  }
}

/** Throws unless `rel` is one of the folders recorded for this run. Called with the exact string that is about to be deleted. */
export function assertRecordedFolder(rel: string, recorded: readonly string[]): string {
  assertFolderShape(rel);
  if (!recorded.includes(rel)) throw new Error(`refusing to delete ${JSON.stringify(rel)}: not recorded for this run`);
  return rel;
}

/** The B2/S3 cleanup target is exactly `<base>/<run-id>` and nothing broader. */
export function assertRunPrefix(prefix: string, runId: string, base: string): string {
  if (!/^r\d{10}[0-9a-f]{4}$/.test(runId)) throw new Error(`bad run id ${JSON.stringify(runId)}`);
  if (!base || /(^|\/)\.\.?(\/|$)|^\/|\/$|\*|\\/.test(base)) throw new Error(`bad prefix base ${JSON.stringify(base)}`);
  if (prefix !== `${base}/${runId}`) throw new Error(`refusing to delete prefix ${JSON.stringify(prefix)}: not ${base}/${runId}`);
  if (/\.\.|^\/|\/$|\*/.test(prefix)) throw new Error(`unsafe prefix ${JSON.stringify(prefix)}`);
  return prefix;
}

/** Single-quote a string for a POSIX shell. */
export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
