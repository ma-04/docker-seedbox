import { expect, test } from '@playwright/test';
import { live } from './env';
import { assertRecordedFolder, assertRunPrefix, shellQuote } from './guards';
import { api, login, rclone, recordedFolders, s3Prefix, sh, state, stateIfExists } from './lib';

test.describe.configure({ mode: 'serial' });

// Removes only what THIS run created, proven against the run-state file (e2e/.out/live/state.json) before every delete.
// Without that file nothing is deleted at all. Run explicitly (`... 99`); it is the last numbered spec on purpose.
test.describe('99. cleanup (this run only)', () => {
  test('precondition: this run has a state file (otherwise cleanup refuses to run)', () => {
    const s = stateIfExists();
    expect(s, 'run-state file missing: refusing to clean up anything (nothing is known to belong to this run)').not.toBeNull();
    expect(s!.runId).toMatch(/^r\d{10}[0-9a-f]{4}$/);
  });

  test('delete the test jobs through the app (local library files go with them)', async ({ browser }) => {
    const j = state().jobs;
    for (const who of ['admin', 'user', 'user2'] as const) {
      const ctx = await browser.newContext(); const page = await ctx.newPage(); await login(page, who);
      for (const job of Object.values(j).filter((x) => x.user === who)) {
        const r = await api(page, 'DELETE', `/api/jobs/${job.id}`);
        expect([200, 204, 404]).toContain(r.status);
      }
      await ctx.close();
    }
  });

  test('B2: delete exactly <base>/<run-id>/ (prefix asserted first)', async () => {
    const prefix = assertRunPrefix(s3Prefix(), state().runId, live.s3.prefixBase());
    expect(prefix.split('/')).toHaveLength(2);           // base/run-id, nothing broader
    const target = `${live.b2Remote()}:${live.s3.bucket()}/${prefix}`;
    const del = await rclone(['delete', '--b2-hard-delete', '--rmdirs', target]);   // objects below that path only
    expect(del.code, del.err).toBe(0);
    const left = await rclone(['lsf', '-R', '--files-only', `${target}/`]);
    expect(left.out.trim()).toBe('');
  });

  test('Drive: remove only the job folders recorded for this run (never a pattern, never another run\'s)', async () => {
    const recorded = recordedFolders();
    const root = live.driveRootFolderId();
    const ls = await rclone(['lsjson', '--dirs-only', '-R', '--max-depth', '2', live.gdriveRemote() + ':', '--drive-root-folder-id', root]);
    expect(ls.code, ls.err).toBe(0);
    const existing = new Set((JSON.parse(ls.out || '[]') as { Path: string }[]).map((d) => d.Path));
    const users = new Set<string>();
    for (const rel of recorded) {
      if (!existing.has(rel)) continue;   // never created (or already gone)
      assertRecordedFolder(rel, recorded);
      const r = await rclone(['purge', '--drive-use-trash=false', `${live.gdriveRemote()}:${rel}`, '--drive-root-folder-id', root]);
      expect(r.code, r.err).toBe(0);
      users.add(rel.split('/')[0]!);
    }
    // a per-user folder left empty by that: `rmdir` only ever removes an EMPTY directory
    for (const u of users) await rclone(['rmdir', `${live.gdriveRemote()}:${u}`, '--drive-root-folder-id', root]);
  });

  test('server: the local library holds none of this run\'s folders (the app removed them; anything left is removed by exact path)', async () => {
    const recorded = recordedFolders();
    const present = async (rel: string): Promise<boolean> =>
      (await sh(`sudo docker exec seedbox-api-1 test -d ${shellQuote(`/downloads/library/${rel}`)}`)).code === 0;
    // deleting a job queues the removal in the worker; give it time
    for (const rel of recorded) {
      assertRecordedFolder(rel, recorded);
      await expect.poll(() => present(rel), { timeout: 120_000, intervals: [3000] }).toBe(false).catch(async () => {
        // still there: remove exactly that recorded folder (no glob, no find over the library, no other user's copy)
        assertRecordedFolder(rel, recorded);
        const r = await sh(`sudo docker exec seedbox-api-1 rm -rf -- ${shellQuote(`/downloads/library/${rel}`)}`);
        expect(r.code, r.err).toBe(0);
      });
      expect(await present(rel), rel).toBe(false);
    }
    const r = await sh(`sudo docker exec seedbox-api-1 sh -c 'ls -la /downloads/library 2>&1; du -sh /downloads 2>&1'; df -h / | tail -1`);
    console.log(r.out);
  });
});
