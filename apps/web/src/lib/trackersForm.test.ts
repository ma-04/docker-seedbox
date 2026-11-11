import { describe, expect, it } from 'vitest';
import type { TrackersDto } from './api';
import { addUrlLine, NGOSANG_ALL, parseUrlLines, trackersPatch, trackersToForm, validateTrackersForm } from './trackersForm';

const dto = (o: Partial<TrackersDto> = {}): TrackersDto => ({
  enabled: true, urls: [], refreshHours: 24, maxTrackers: 200, lists: [], manualCount: 0, effectiveCount: 0, refreshRequestedAt: null, ...o,
});

describe('tracker lists form', () => {
  it('round-trips with no patch when nothing changed', () => {
    const cur = dto({ urls: [NGOSANG_ALL, 'https://lists.example.org/b.txt'] });
    const f = trackersToForm(cur);
    expect(f.urls).toBe(`${NGOSANG_ALL}\nhttps://lists.example.org/b.txt`);
    expect(trackersPatch(cur, f)).toEqual({});
  });

  it('parses one URL per line, ignoring blanks, whitespace, CRLF and duplicates', () => {
    expect(parseUrlLines(' https://a.example.org/x \r\n\r\nhttps://a.example.org/x\nhttps://b.example.org/y\n')).toEqual(['https://a.example.org/x', 'https://b.example.org/y']);
  });

  it('the quick-fill adds the ngosang list once', () => {
    const once = addUrlLine('', NGOSANG_ALL);
    expect(once).toBe(NGOSANG_ALL);
    expect(addUrlLine(once, NGOSANG_ALL)).toBe(NGOSANG_ALL);
    expect(addUrlLine('https://a.example.org/x', NGOSANG_ALL)).toBe(`https://a.example.org/x\n${NGOSANG_ALL}`);
  });

  it('patches only the changed keys with numbers', () => {
    const cur = dto();
    const f = { ...trackersToForm(cur), urls: NGOSANG_ALL, maxTrackers: '50' };
    expect(trackersPatch(cur, f)).toEqual({ urls: [NGOSANG_ALL], maxTrackers: 50 });
    expect(trackersPatch(dto({ urls: [NGOSANG_ALL] }), { ...f, urls: '' })).toEqual({ urls: [], maxTrackers: 50 });
  });

  it.each([
    ['http scheme', { urls: 'http://a.example.org/x' }, /https/],
    ['credentials', { urls: 'https://u:p@a.example.org/x' }, /credentials/],
    ['not a URL', { urls: 'nope' }, /valid URL/],
    ['six URLs', { urls: Array.from({ length: 6 }, (_, i) => `https://l${i}.example.org/x`).join('\n') }, /At most 5/],
    ['too-long URL', { urls: `https://a.example.org/${'x'.repeat(2100)}` }, /longer/],
    ['refresh 0', { refreshHours: '0' }, /1 to 720/],
    ['refresh 721', { refreshHours: '721' }, /1 to 720/],
    ['refresh fraction', { refreshHours: '1.5' }, /1 to 720/],
    ['max 0', { maxTrackers: '0' }, /1 to 1000/],
    ['max 1001', { maxTrackers: '1001' }, /1 to 1000/],
  ])('validates: %s', (_n, o, re) => {
    expect(validateTrackersForm({ ...trackersToForm(dto()), ...o })).toMatch(re);
  });

  it('accepts a good form and an empty URL list', () => {
    expect(validateTrackersForm({ urls: NGOSANG_ALL, refreshHours: '24', maxTrackers: '200' })).toBeNull();
    expect(validateTrackersForm({ urls: '', refreshHours: '1', maxTrackers: '1000' })).toBeNull();
  });
});
