import { describe, expect, it } from 'vitest';
import { buildRcloneCommand, parseStatsLine, redact } from './rclone.js';

describe('buildRcloneCommand', () => {
  it('gdrive: credentials only in env', () => {
    const c = buildRcloneCommand(
      { type: 'gdrive', clientId: 'cid', clientSecret: 'csecret', refreshToken: 'rtoken', rootFolderId: 'ROOT', sharing: 'none' },
      '/src/Pack', 'alice/Pack',
    );
    expect(c.args.slice(0, 3)).toEqual(['copy', '/src/Pack', 'DST:alice/Pack']);
    expect(c.args).toEqual(expect.arrayContaining(['--use-json-log', '--stats', '1s', '--stats-log-level', 'NOTICE', '--transfers', '4', '--retries', '3', '--low-level-retries', '10', '-v']));
    expect(c.args.join('\0')).not.toMatch(/csecret|rtoken/);
    expect(c.env).toMatchObject({
      RCLONE_CONFIG_DST_TYPE: 'drive', RCLONE_CONFIG_DST_CLIENT_ID: 'cid', RCLONE_CONFIG_DST_CLIENT_SECRET: 'csecret',
      RCLONE_CONFIG_DST_SCOPE: 'drive.file', RCLONE_CONFIG_DST_ROOT_FOLDER_ID: 'ROOT',
    });
    expect(JSON.parse(c.env.RCLONE_CONFIG_DST_TOKEN!)).toMatchObject({ refresh_token: 'rtoken', token_type: 'Bearer', access_token: '', expiry: '2000-01-01T00:00:00Z' });
    expect(Object.keys(c.env).every((k) => k.startsWith('RCLONE_CONFIG_'))).toBe(true);
    expect(c.secrets).toEqual(expect.arrayContaining(['csecret', 'rtoken']));
  });

  it('s3: bucket + prefix target, path-style default, no secrets in argv', () => {
    const c = buildRcloneCommand(
      { type: 's3', endpoint: 'https://s3.example.test', region: 'r', accessKeyId: 'AKID1234', secretAccessKey: 'SECRETKEY', bucket: 'b', prefix: '/pre/' },
      '/src/f.bin', 'bob/Name',
    );
    expect(c.args[2]).toBe('DST:b/pre/bob/Name');
    expect(c.args).toContain('--s3-no-check-bucket');
    expect(c.args.join('\0')).not.toMatch(/AKID1234|SECRETKEY/);
    expect(c.env).toMatchObject({ RCLONE_CONFIG_DST_TYPE: 's3', RCLONE_CONFIG_DST_PROVIDER: 'Other', RCLONE_CONFIG_DST_FORCE_PATH_STYLE: 'true', RCLONE_CONFIG_DST_ACCESS_KEY_ID: 'AKID1234' });
    const c2 = buildRcloneCommand({ type: 's3', endpoint: 'e', region: 'r', accessKeyId: 'a', secretAccessKey: 's', bucket: 'b', forcePathStyle: false }, '/s', 'x');
    expect(c2.env.RCLONE_CONFIG_DST_FORCE_PATH_STYLE).toBe('false');
    expect(c2.args[2]).toBe('DST:b/x');
  });
});

describe('parsing', () => {
  it('parseStatsLine', () => {
    expect(parseStatsLine('{"level":"warning","stats":{"bytes":5,"totalBytes":10,"speed":2.5}}')).toEqual({ bytes: 5, totalBytes: 10, speed: 2.5 });
    expect(parseStatsLine('{"level":"info","msg":"x"}')).toBeNull();
    expect(parseStatsLine('not json')).toBeNull();
    expect(parseStatsLine('{broken')).toBeNull();
  });
  it('redact', () => {
    const t = redact('token=abc refresh_token: "1//xyz" Bearer ya29.AAAA secret-literal-value', ['secret-literal-value']);
    expect(t).not.toMatch(/xyz|ya29|secret-literal/);
    expect(redact('Failed to copy: directory not found')).toBe('Failed to copy: directory not found');
  });
});
