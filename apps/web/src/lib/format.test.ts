import { describe, expect, it } from 'vitest';
import { bytesToGb, formatAge, formatBytes, formatDuration, formatPercent, formatSpeed, gbToBytes } from './format';

describe('format', () => {
  it('formats bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.00 KB');
    expect(formatBytes(1536 * 1024)).toBe('1.50 MB');
    expect(formatBytes(15 * 1024 ** 3)).toBe('15.0 GB');
    expect(formatBytes(null)).toBe('-');
    expect(formatBytes(-1)).toBe('-');
  });
  it('formats speed', () => {
    expect(formatSpeed(2048)).toBe('2.00 KB/s');
    expect(formatSpeed(undefined)).toBe('-');
  });
  it('formats duration', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(59)).toBe('59s');
    expect(formatDuration(125)).toBe('2m 5s');
    expect(formatDuration(3725)).toBe('1h 2m');
    expect(formatDuration(90000)).toBe('1d 1h');
    expect(formatDuration(NaN)).toBe('-');
  });
  it('formats age', () => {
    expect(formatAge(1000, 1003)).toBe('just now');
    expect(formatAge(1000, 1300)).toBe('5m ago');
    expect(formatAge(1000, 1000 + 3 * 86400)).toBe('3d ago');
    expect(formatAge(null)).toBe('never');
  });
  it('formats percent and GB', () => {
    expect(formatPercent(0.456)).toBe('46%');
    expect(formatPercent(2)).toBe('100%');
    expect(gbToBytes(2)).toBe(2 * 1024 ** 3);
    expect(bytesToGb(1.5 * 1024 ** 3)).toBe(1.5);
  });
});
