import { expect, test } from '@playwright/test';
import { live } from './env';
import { api, login, rclone, s3Prefix, sh, state } from './lib';

test.describe.configure({ mode: 'serial' });

// Removes only what this run created. Run explicitly (`... 99`); it is the last numbered spec on purpose.
test.describe('99. cleanup (this run only)', () => {
  test('delete the test jobs (the engine copy goes with them)', async ({ browser }) => {
    const j = state().jobs;
    for (const who of ['admin', 'user', 'user2'] as const) {
      const ctx = await browser.newContext(); const page = await ctx.newPage(); await login(page, who);
      for (const job of Object.values(j).filter((x) => x.user === who)) {
        const r = await api(page, 'DELETE', `/api/jobs/${job.id}`);
        expect([204, 404]).toContain(r.status);
      }
      await ctx.close();
    }
  });

  test('B2: delete exactly <base>/<run-id>/ (prefix asserted first)', async () => {
    const runId = state().runId;
    const prefix = s3Prefix();
    expect(runId).toMatch(/^r\d{10}[0-9a-f]{4}$/);
    expect(prefix).toBe(`${live.s3.prefixBase()}/${runId}`);
    expect(prefix.split('/')).toHaveLength(2);           // base/run-id, nothing broader
    expect(prefix).not.toMatch(/\.\.|^\/|\/$|\*/);
    const target = `${live.b2Remote()}:${live.s3.bucket()}/${prefix}`;
    const del = await rclone(['delete', '--b2-hard-delete', '--rmdirs', target]);   // objects below that path only
    expect(del.code, del.err).toBe(0);
    const left = await rclone(['lsf', '-R', '--files-only', `${target}/`]);
    expect(left.out.trim()).toBe('');
  });

  test('Drive: remove only the job folders this run created under the root folder', async () => {
    const debianHash8 = (state().hashes as { debian: string }).debian.slice(0, 8);
    const root = live.driveRootFolderId();
    const base = [live.gdriveRemote() + ':', '--drive-root-folder-id', root];
    const ls = await rclone(['lsjson', '--dirs-only', '-R', '--max-depth', '2', ...base]);
    expect(ls.code, ls.err).toBe(0);
    const dirs = (JSON.parse(ls.out || '[]') as { Path: string }[]).map((d) => d.Path);
    const mine = dirs.filter((p) => p.split('/').length === 2 && p.endsWith(`[${debianHash8}]`));
    for (const p of mine) {
      expect(p).toMatch(/^[^/]+\/[^/]+ \[[0-9a-f]{8}\]$/);
      const r = await rclone(['purge', '--drive-use-trash=false', `${live.gdriveRemote()}:${p}`, '--drive-root-folder-id', root]);
      expect(r.code, r.err).toBe(0);
    }
    // user folders left empty by that
    for (const u of new Set(mine.map((p) => p.split('/')[0]!))) await rclone(['rmdir', `${live.gdriveRemote()}:${u}`, '--drive-root-folder-id', root]);
  });

  test('server: the big ISO is gone from the library; show what is left', async () => {
    const r = await sh(`sudo docker exec seedbox-api-1 sh -c 'ls -la /downloads/library 2>&1; du -sh /downloads 2>&1' ; df -h / | tail -1`);
    const ubuntuName = (state().ubuntu as { name: string }).name;
    const find = await sh(`sudo docker run --rm -v seedbox_downloads:/d:ro alpine sh -c 'find /d -name "${ubuntuName}*" | head'`);
    expect(find.out.trim(), r.out).toBe('');
  });
});
