import { useEffect, useState } from 'react';
import type { JobDto } from '../lib/api';
import { jobStep } from '../lib/jobs';
import { Badge, cx } from './ui';

const TONE: Record<JobDto['state'], 'gray' | 'blue' | 'amber' | 'green' | 'red'> = {
  queued: 'gray', downloading: 'blue', uploading: 'amber', completed: 'green', failed: 'red', cancelled: 'gray',
};
export const StateBadge = ({ state }: { state: JobDto['state'] }) => <Badge tone={TONE[state]}>{state}</Badge>;

/** Unix seconds, refreshed every `everyMs` so "no progress for N min" keeps counting without new server events. */
function useNowSec(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

/** Which step a download is on (Queued → Connecting → Downloading → Uploading → Done) and what it is waiting on. */
export function JobSteps({ job, compact = false }: { job: JobDto; compact?: boolean }) {
  const step = jobStep(job, useNowSec());
  if (!step) return null;
  const message = (
    <p data-testid="job-step-message" data-stuck={step.stuck || undefined}
      className={cx('text-xs', step.stuck ? 'font-medium text-amber-700 dark:text-amber-400' : 'text-slate-500')}>
      {step.stuck && <span aria-hidden="true">⚠ </span>}{step.message}
    </p>
  );
  if (compact) return <div data-testid="job-step" data-step={step.steps[step.index]}><span className="text-xs font-medium">{step.steps[step.index]}</span>{message}</div>;
  return (
    <div data-testid="job-step" data-step={step.steps[step.index]} className="mt-2">
      <ol aria-label="Download steps" className="flex flex-wrap items-center gap-x-1 gap-y-1 text-xs">
        {step.steps.map((name, i) => {
          const done = i < step.index || (i === step.index && i === step.steps.length - 1);
          const current = i === step.index && !done;
          return (
            <li key={name} aria-current={current ? 'step' : undefined} className="flex items-center gap-1">
              {i > 0 && <span aria-hidden="true" className="text-slate-300 dark:text-slate-600">›</span>}
              <span className={cx('rounded-full px-2 py-0.5',
                done && 'text-emerald-700 dark:text-emerald-400',
                current && (step.stuck ? 'bg-amber-100 font-semibold text-amber-800 dark:bg-amber-900/40 dark:text-amber-300' : 'bg-brand-100 font-semibold text-brand-700 dark:bg-brand-500/20 dark:text-brand-100'),
                !done && !current && 'text-slate-400 dark:text-slate-500')}>
                {done && <span aria-hidden="true">✓ </span>}{name}
              </span>
            </li>
          );
        })}
      </ol>
      <div className="mt-1">{message}</div>
    </div>
  );
}
