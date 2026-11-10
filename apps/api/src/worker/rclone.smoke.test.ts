/** Runs the real rclone binary (skipped when it is not installed) against a `local` remote defined via env. */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RcloneError, rcloneArgs, runRclone, type RcloneStats, type SpawnFn } from './rclone.js';

const bin = process.env.RCLONE_BIN || 'rclone';
const have = spawnSync(bin, ['version']).status === 0;
const realSpawn: SpawnFn = (cmd, args, opts) => spawn(cmd, args, { env: opts.env, stdio: ['ignore', 'ignore', 'pipe'] });

describe.skipIf(!have)('real rclone', () => {
  it('copies a tree, parses JSON stats, writes no config', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rclone-smoke-'));
    const src = join(root, 'src'); const dst = join(root, 'dst'); const home = join(root, 'home');
    mkdirSync(join(src, 'sub dir'), { recursive: true });
    mkdirSync(home);
    writeFileSync(join(src, "sub dir", "ünï #1 100% it's.bin"), Buffer.alloc(3_000_000, 1));
    writeFileSync(join(src, 'a.txt'), 'hello');
    const stats: RcloneStats[] = [];
    await runRclone({
      spawn: realSpawn, bin,
      cmd: { args: rcloneArgs(src, `DST:${dst}`, ['--bwlimit', '1.5M']), env: { RCLONE_CONFIG_DST_TYPE: 'local', HOME: home }, secrets: [] },
      onStats: (s) => stats.push(s),
    });
    expect(readFileSync(join(dst, 'a.txt'), 'utf8')).toBe('hello');
    expect(readFileSync(join(dst, 'sub dir', "ünï #1 100% it's.bin")).length).toBe(3_000_000);
    expect(stats.length).toBeGreaterThan(0);
    const last = stats.at(-1)!;
    expect(last.totalBytes).toBe(3_000_005);
    expect(last.bytes).toBeGreaterThan(0);
    expect(last.bytes).toBeLessThanOrEqual(last.totalBytes);
    expect(typeof last.speed).toBe('number');
    expect(spawnSync('ls', ['-A', home]).stdout.toString()).toBe(''); // no ~/.config/rclone written
  }, 30_000);

  it('a missing source fails with a readable message', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rclone-smoke-'));
    const err = await runRclone({
      spawn: realSpawn, bin,
      cmd: { args: rcloneArgs(join(root, 'nope'), `DST:${join(root, 'dst')}`), env: { RCLONE_CONFIG_DST_TYPE: 'local' }, secrets: [] },
      onStats: () => {},
    }).catch((e) => e);
    expect(err).toBeInstanceOf(RcloneError);
    expect((err as Error).message).toMatch(/rclone failed \(exit \d+\)/);
  }, 30_000);
});
