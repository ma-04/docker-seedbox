import { describe, expect, it } from 'vitest';
import parseTorrent from 'parse-torrent';
import { parseStrictTorrent, rebuildTorrent } from './torrent-file.js';

// Torrents made by a REAL client (transmission-create 4.0.5, the tool the e2e seeder uses; alpine:3.20 `transmission-extra`),
// committed as base64. The strict canonical check must accept what real clients emit.
const MULTI = 'ZDg6YW5ub3VuY2UzNDpodHRwOi8vMTk4LjUxLjEwMC4zMDo2OTY5L2Fubm91bmNlMTA6Y3JlYXRlZCBieTMxOlRyYW5zbWlzc2lvbi80LjAuNSAoYTZmZTJhNjRhYSkxMzpjcmVhdGlvbiBkYXRlaTE3OTQzNzQ1MTNlODplbmNvZGluZzU6VVRGLTg0OmluZm9kNTpmaWxlc2xkNjpsZW5ndGhpNzAwMDBlNDpwYXRobDU6YS5iaW5lZWQ2Omxlbmd0aGkzMzAwMGU0OnBhdGhsMzpzdWIxMTrDvG7DryBiLmJpbmVlZTQ6bmFtZTU6TXVsdGkxMjpwaWVjZSBsZW5ndGhpMzI3NjhlNjpwaWVjZXM4MDqj0jOwMpw3jjc6OWSuy/W26EiwgBdeUzybPtXxAowRpatw+ONhrHtkoUCyodTrzKyoZtEJyfEP+1lE1Q7xnC4su4ML8dN9/Z8Gse8Jo+ScHWVl';
const SINGLE = 'ZDg6YW5ub3VuY2UzOTp1ZHA6Ly90cmFja2VyLmV4YW1wbGUuY29tOjEzMzcvYW5ub3VuY2UxMDpjcmVhdGVkIGJ5MzE6VHJhbnNtaXNzaW9uLzQuMC41IChhNmZlMmE2NGFhKTEzOmNyZWF0aW9uIGRhdGVpMTc5NDM3NDUxM2U4OmVuY29kaW5nNTpVVEYtODQ6aW5mb2Q2Omxlbmd0aGkyMDAwMGU0Om5hbWUxMDpTaW5nbGUuYmluMTI6cGllY2UgbGVuZ3RoaTMyNzY4ZTY6cGllY2VzMjA6wyUAO8Q1g+FYJ6c33wZgoduv7oQ3OnByaXZhdGVpMWVlZQ==';

describe('strict parsing accepts torrents made by a real client', () => {
  it.each([['multi-file (unicode path, tracker, created by/encoding)', MULTI, 103000, 'Multi', 4], ['single-file, private', SINGLE, 20000, 'Single.bin', 1]] as const)('%s', async (_n, b64, size, name, pieces) => {
    const buf = Buffer.from(b64, 'base64');
    const t = parseStrictTorrent(buf);
    expect(t).toMatchObject({ totalSize: size, name, pieceCount: pieces });
    expect(t.infohash).toBe((await parseTorrent(new Uint8Array(buf))).infoHash);
    const r = rebuildTorrent(buf);
    expect(r.infohash).toBe(t.infohash);
    expect(r.trackers).toEqual(name === 'Multi' ? [] : ['udp://tracker.example.com:1337/announce']); // the TEST-NET tracker is not public
    expect((await parseTorrent(new Uint8Array(r.file))).infoHash).toBe(t.infohash);
  });
});
