const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return '-';
  let v = n;
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i++; }
  const digits = i === 0 || v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(digits)} ${UNITS[i]}`;
}

export function formatSpeed(bps: number | null | undefined): string {
  if (bps == null || !Number.isFinite(bps) || bps < 0) return '-';
  return `${formatBytes(bps)}/s`;
}

/** 3725 -> "1h 2m"; 59 -> "59s"; 0 -> "0s" */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '-';
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ''}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24 ? ` ${h % 24}h` : ''}`;
}

/** Relative time for unix-second timestamps: "just now", "5m ago", "3d ago". */
export function formatAge(ts: number | null | undefined, nowSec: number = Math.floor(Date.now() / 1000)): string {
  if (ts == null || !Number.isFinite(ts) || ts <= 0) return 'never';
  const diff = nowSec - ts;
  if (diff < 10) return 'just now';
  const d = formatDuration(diff).split(' ')[0];
  return `${d} ago`;
}

export function formatPercent(p: number): string {
  if (!Number.isFinite(p)) return '0%';
  return `${Math.round(Math.min(1, Math.max(0, p)) * 100)}%`;
}

export const GB = 1024 ** 3;
export const bytesToGb = (b: number): number => Math.round((b / GB) * 100) / 100;
export const gbToBytes = (gb: number): number => Math.round(gb * GB);
