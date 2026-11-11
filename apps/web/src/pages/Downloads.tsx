import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { StateBadge } from '../components/JobParts';
import { Button, ConfirmButton, Empty, ErrorNote, Field, PageHeader, Progress, Spinner, cx, errMsg, useToast } from '../components/ui';
import { endpoints, type JobDto } from '../lib/api';
import { formatAge, formatBytes, formatSpeed } from '../lib/format';
import { useDestinations, useMe } from '../lib/hooks';
import { safeHttpUrl } from '../lib/url';
import { BrowserIntegration } from '../components/BrowserIntegration';
import { clearPendingIncoming, peekPendingIncoming } from '../lib/magnet';
import { displayName, filterJobs, isActive, mergeJob, removeNotice, type JobFilter } from '../lib/jobs';

const FILTERS: { id: JobFilter; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'active', label: 'Active' }, { id: 'completed', label: 'Completed' }, { id: 'failed', label: 'Failed' },
];

/** Live updates: SSE `job` events merged into the cache; polling (refetchInterval) is the fallback. */
export function useJobsLive() {
  const qc = useQueryClient();
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const es = new EventSource('/api/events');
    const onJob = (ev: MessageEvent) => {
      try {
        const job = JSON.parse(ev.data) as JobDto;
        qc.setQueryData<JobDto[]>(['jobs'], (old) => mergeJob(old, job));
      } catch { /* ignore malformed event */ }
    };
    es.addEventListener('job', onJob as EventListener);
    return () => { es.removeEventListener('job', onJob as EventListener); es.close(); };
  }, [qc]);
  return useQuery({ queryKey: ['jobs'], queryFn: endpoints.jobs, refetchInterval: 5000 });
}

function AddForm() {
  const qc = useQueryClient();
  const toast = useToast();
  const dests = useDestinations();
  const options = useMemo(() => (dests.data ?? []).filter((d) => d.enabled), [dests.data]);
  const [magnet, setMagnet] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [destId, setDestId] = useState<number | null>(null);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const destRef = useRef<HTMLSelectElement>(null);
  // A magnet handed over by /add (browser protocol handler). Pre-filled only, never submitted automatically.
  const [incoming] = useState(peekPendingIncoming);
  const [prefillDone, setPrefillDone] = useState(false);
  const [notice, setNotice] = useState(incoming?.magnet ? { name: incoming.magnet.name, infohash: incoming.magnet.infohash } : null);

  useEffect(() => { clearPendingIncoming(); }, []);
  useEffect(() => { if (incoming?.magnet) setMagnet(incoming.magnet.uri); }, [incoming]);

  useEffect(() => {
    if (!options.length) return;
    if (incoming?.magnet && !prefillDone) {
      const wanted = incoming.destinationId !== null ? options.find((d) => d.id === incoming.destinationId) : undefined;
      setDestId((wanted ?? options.find((d) => d.isDefault) ?? options[0])!.id);
      setPrefillDone(true);
      destRef.current?.focus();
    } else if (destId === null) setDestId((options.find((d) => d.isDefault) ?? options[0])!.id);
  }, [options, destId, incoming, prefillDone]);

  const add = useMutation({
    mutationFn: () => {
      if (destId === null) throw new Error('Choose a destination first');
      if (file) return endpoints.addTorrentFile(file, destId);
      if (magnet.trim()) return endpoints.addMagnet(magnet.trim(), destId);
      throw new Error('Paste a magnet link or choose a .torrent file');
    },
    onSuccess: (job) => {
      qc.setQueryData<JobDto[]>(['jobs'], (old) => mergeJob(old, job));
      setMagnet(''); setFile(null); setNotice(null);
      if (fileRef.current) fileRef.current.value = '';
      toast('ok', 'Download added');
    },
  });

  const onDrop = (e: DragEvent) => {
    e.preventDefault(); setDrag(false);
    const f = e.dataTransfer.files?.[0];
    if (f) setFile(f);
  };
  const submit = (e: FormEvent) => { e.preventDefault(); add.mutate(); };

  return (
    <form data-testid="add-form" onSubmit={submit} className="card mb-6 space-y-3" aria-label="Add torrent"
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
      <h2 className="text-base font-semibold">Add a torrent</h2>
      {incoming?.error && <div data-testid="magnet-error"><ErrorNote error={new Error(incoming.error)} /></div>}
      {notice && (
        <p data-testid="magnet-prefill" role="status" className="rounded-md bg-brand-100 px-3 py-2 text-sm text-brand-700 dark:bg-brand-700/30 dark:text-brand-100">
          Magnet link received from your browser{notice.name ? <>: <strong data-testid="magnet-prefill-name">{notice.name}</strong></> : ''}. Check it, pick a destination and press Add download.
        </p>
      )}
      <div className={cx('grid gap-3 md:grid-cols-2', drag && 'rounded-md outline outline-2 outline-dashed outline-brand-500')}>
        <Field label="Magnet link" hint="Paste a magnet: link.">
          {(id) => <textarea id={id} data-testid="magnet-input" rows={3} className="input font-mono" placeholder="magnet:?xt=urn:btih:..." value={magnet} onChange={(e) => { setMagnet(e.target.value); setNotice(null); }} />}
        </Field>
        <Field label="Torrent file" hint={file ? `Selected: ${file.name}` : 'Choose or drop a .torrent file here.'}>
          {(id) => (
            <input id={id} ref={fileRef} data-testid="torrent-file" type="file" accept=".torrent,application/x-bittorrent"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-slate-200 file:px-3 file:py-1.5 file:text-sm file:font-medium dark:file:bg-slate-700" />
          )}
        </Field>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[12rem] flex-1 md:max-w-xs">
          <Field label="Destination">
            {(id) => (
              <select id={id} ref={destRef} data-testid="destination-select" className="input" value={destId ?? ''} onChange={(e) => setDestId(Number(e.target.value))} disabled={!options.length}>
                {options.map((d) => <option key={d.id} value={d.id}>{d.name}{d.shared ? ' (shared)' : ''}</option>)}
              </select>
            )}
          </Field>
        </div>
        <Button type="submit" variant="primary" data-testid="add-submit" disabled={add.isPending || !options.length}>{add.isPending ? 'Adding...' : 'Add download'}</Button>
      </div>
      {!dests.isLoading && !options.length && <p className="text-sm text-amber-700 dark:text-amber-400">No destination available. Add an S3 destination on the Storage page or ask an admin to configure a shared one.</p>}
      <ErrorNote error={add.error ?? dests.error} />
    </form>
  );
}

export function JobFiles({ job }: { job: JobDto }) {
  const toast = useToast();
  const q = useQuery({ queryKey: ['job-files', job.id], queryFn: () => endpoints.jobFiles(job.id) });
  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(new URL(url, window.location.origin).href);
      toast('ok', 'Link copied');
    } catch { toast('error', 'Could not copy link'); }
  };
  if (q.isLoading) return <Spinner label="Loading files" />;
  if (q.error) return <ErrorNote error={q.error} />;
  const data = q.data!;
  const folderUrl = safeHttpUrl(data.folderUrl ?? job.folderUrl);
  return (
    <div className="mt-3 rounded-md bg-slate-50 p-3 dark:bg-slate-950" role="region" aria-label={`Files of ${displayName(job)}`}>
      {folderUrl && (
        <p className="mb-2 text-sm">
          <a data-testid="folder-link" href={folderUrl} target="_blank" rel="noreferrer" className="font-medium text-brand-600 hover:underline">Open shared folder</a>
        </p>
      )}
      {data.files.length === 0 ? <p className="text-sm text-slate-500">No files recorded.</p> : (
        <ul className="divide-y divide-slate-200 dark:divide-slate-800">
          {data.files.map((f) => (
            <li key={f.path} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-sm">
              <span className="min-w-0 flex-1 break-all">{f.path}</span>
              <span className="text-xs text-slate-500">{formatBytes(f.size)}</span>
              {safeHttpUrl(f.url) ? (
                <>
                  <a data-testid="file-link" href={f.url ?? undefined} target="_blank" rel="noreferrer" download className="font-medium text-brand-600 hover:underline">Download</a>
                  <Button size="sm" variant="ghost" aria-label={`Copy link for ${f.path}`} onClick={() => copy(f.url!)}>Copy link</Button>
                </>
              ) : <span className="text-xs italic text-slate-500">no direct link</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function JobRow({ job }: { job: JobDto }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const me = useMe();
  const notice = removeNotice(job, me.data?.cleanup.deleteRemoteOnJobDelete ?? false);
  const remove = useMutation({
    mutationFn: () => endpoints.deleteJob(job.id),
    onSuccess: () => { qc.setQueryData<JobDto[]>(['jobs'], (o) => o?.filter((j) => j.id !== job.id)); qc.invalidateQueries({ queryKey: ['jobs'] }); },
    onError: (e) => toast('error', errMsg(e)),
  });
  const retry = useMutation({
    mutationFn: () => endpoints.retryJob(job.id),
    onSuccess: (j) => qc.setQueryData<JobDto[]>(['jobs'], (o) => mergeJob(o, j)),
    onError: (e) => toast('error', errMsg(e)),
  });
  return (
    <li data-testid="job-row" data-state={job.state} data-job-id={job.id} className="card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="break-all text-sm font-semibold" title={job.infohash}>{displayName(job)}</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            {job.destination.name} · {job.totalSize ? formatBytes(job.totalSize) : 'size pending'} · {formatAge(job.createdAt)}
          </p>
        </div>
        <StateBadge state={job.state} />
      </div>
      {(job.state === 'downloading' || job.state === 'queued') && (
        <div className="mt-2">
          <Progress value={job.downloadProgress} label={`Download progress of ${displayName(job)}`} />
          <p className="mt-1 text-xs text-slate-500">Downloading {Math.round(job.downloadProgress * 100)}%{job.state === 'downloading' && ` · ${formatSpeed(job.downloadSpeed)}`}</p>
        </div>
      )}
      {job.state === 'uploading' && (
        <div className="mt-2">
          <Progress tone="blue" value={job.uploadProgress} label={`Upload progress of ${displayName(job)}`} />
          <p className="mt-1 text-xs text-slate-500">Uploading {Math.round(job.uploadProgress * 100)}% · {formatSpeed(job.uploadSpeed)}</p>
        </div>
      )}
      {job.error && <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">{job.error}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {job.state === 'completed' && <Button size="sm" data-testid="job-files" aria-expanded={open} onClick={() => setOpen((o) => !o)}>Files</Button>}
        {(job.state === 'failed' || job.state === 'cancelled') && <Button size="sm" disabled={retry.isPending} onClick={() => retry.mutate()}>Retry</Button>}
        {notice
          ? <ConfirmButton label="Remove" confirmLabel="Yes, remove" description={notice} disabled={remove.isPending} onConfirm={() => remove.mutate()} />
          : <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate()}>{isActive(job) ? 'Cancel' : 'Remove'}</Button>}
      </div>
      {open && job.state === 'completed' && <JobFiles job={job} />}
    </li>
  );
}

export default function Downloads() {
  const jobs = useJobsLive();
  const [filter, setFilter] = useState<JobFilter>('all');
  const shown = useMemo(() => filterJobs(jobs.data ?? [], filter), [jobs.data, filter]);
  return (
    <>
      <PageHeader title="Downloads" />
      <AddForm />
      <BrowserIntegration />
      <div role="tablist" aria-label="Filter downloads" className="mb-3 flex gap-1">
        {FILTERS.map((f) => (
          <button key={f.id} role="tab" type="button" aria-selected={filter === f.id} onClick={() => setFilter(f.id)}
            className={cx('rounded-md px-3 py-1.5 text-sm font-medium', filter === f.id ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800')}>
            {f.label}
          </button>
        ))}
      </div>
      {jobs.isLoading ? <Spinner label="Loading downloads" /> : jobs.error ? <ErrorNote error={jobs.error} /> : shown.length === 0 ? (
        <Empty>{filter === 'all' ? 'No downloads yet. Add a magnet link or .torrent file above.' : `No ${filter} downloads.`}</Empty>
      ) : (
        <ul className="space-y-3" aria-label="Downloads">{shown.map((j) => <JobRow key={j.id} job={j} />)}</ul>
      )}
    </>
  );
}
