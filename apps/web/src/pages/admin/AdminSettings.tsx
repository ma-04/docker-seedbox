import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button, Check, ErrorNote, Field, PageHeader, Spinner, useToast } from '../../components/ui';
import { ApiError, endpoints, type EngineSettingsDto } from '../../lib/api';
import { formatAge } from '../../lib/format';
import { addUrlLine, NGOSANG_ALL, trackersPatch, trackersToForm, validateTrackersForm, type TrackersForm } from '../../lib/trackersForm';
import { enginePatch, engineToForm, ENGINE_NUM_KEYS as NUM_KEYS, limitsPatch, limitsToForm, type EngineForm, type LimitsForm } from '../../lib/settingsForm';

export default function AdminSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['admin-settings'], queryFn: endpoints.admin.settings });
  const [f, setF] = useState<LimitsForm>({ maxJobs: '', maxGb: '', minFreeGb: '', ratio: '', seedMaxMinutes: '', failedGraceMinutes: '', metadataTimeoutMinutes: '', deleteRemote: false });
  useEffect(() => { if (q.data) setF(limitsToForm(q.data)); }, [q.data]);
  const save = useMutation({
    mutationFn: () => {
      const patch = limitsPatch(q.data!, f);
      if (!Object.keys(patch).length) return Promise.resolve(q.data!);
      return endpoints.admin.updateSettings(patch);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin-settings'] }); toast('ok', 'Settings saved'); },
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  if (q.isLoading) return <Spinner />;
  return (
    <>
      <PageHeader title="Settings" />
      <ErrorNote error={q.error} />
      {q.data && (
        <form className="card max-w-xl space-y-4" aria-label="Limits and seeding" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <Field label="Max active jobs per user" hint="Users can have a per-user override on the Users page.">
            {(id) => <input id={id} type="number" min={0} className="input" value={f.maxJobs} onChange={set('maxJobs')} />}
          </Field>
          <Field label="Max torrent size (GB)" hint="0 = unlimited.">
            {(id) => <input id={id} type="number" min={0} step="any" className="input" value={f.maxGb} onChange={set('maxGb')} />}
          </Field>
          <Field label="Minimum free disk space (GB)" hint="New downloads are refused below this.">
            {(id) => <input id={id} type="number" min={0} step="any" className="input" value={f.minFreeGb} onChange={set('minFreeGb')} />}
          </Field>
          <Field label="Seeding ratio" hint="0 = stop as soon as the download completes.">
            {(id) => <input id={id} type="number" min={0} step="any" className="input" value={f.ratio} onChange={set('ratio')} />}
          </Field>
          <Field label="Stop seeding after (minutes)" hint="Only with a seeding ratio above 0. 0 = no time cap.">
            {(id) => <input id={id} type="number" min={0} step={1} className="input" value={f.seedMaxMinutes} onChange={set('seedMaxMinutes')} />}
          </Field>
          <Field label="Keep data after a failed upload (minutes)" hint="So Retry can skip the download. 0 = remove right away.">
            {(id) => <input id={id} type="number" min={0} step={1} className="input" value={f.failedGraceMinutes} onChange={set('failedGraceMinutes')} />}
          </Field>
          <Field label="Magnet metadata timeout (minutes)" hint="A magnet that finds no metadata within this time fails. 0 = wait forever.">
            {(id) => <input id={id} type="number" min={0} step={1} className="input" value={f.metadataTimeoutMinutes} onChange={set('metadataTimeoutMinutes')} />}
          </Field>
          <div>
            <Check label="Delete uploaded S3 files when a completed job is removed" checked={f.deleteRemote} onChange={(v) => setF((s) => ({ ...s, deleteRemote: v }))} />
            <p className="hint">Off by default: removing a job only deletes local-folder files. S3 only; Google Drive files are never deleted automatically.</p>
          </div>
          <ErrorNote error={save.error} />
          <Button type="submit" variant="primary" disabled={save.isPending}>{save.isPending ? 'Saving...' : 'Save settings'}</Button>
        </form>
      )}
      <TrackerLists />
      <EngineSettings />
    </>
  );
}

/** Extra trackers fetched from public lists (the app downloads and filters them; the worker hands them to the torrent engine). */
function TrackerLists() {
  const qc = useQueryClient();
  const toast = useToast();
  const [pollUntil, setPollUntil] = useState(0);
  const q = useQuery({
    queryKey: ['admin-trackers'], queryFn: endpoints.admin.trackers,
    refetchInterval: (query) => (query.state.data?.refreshRequestedAt || Date.now() < pollUntil ? 2000 : false),
  });
  const [f, setF] = useState<TrackersForm>({ urls: '', refreshHours: '24', maxTrackers: '200' });
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (q.data && !dirty) setF(trackersToForm(q.data)); }, [q.data, dirty]);
  const problem = validateTrackersForm(f);
  const edit = (patch: Partial<TrackersForm>) => { setDirty(true); setF((s) => ({ ...s, ...patch })); };

  const save = useMutation({
    mutationFn: () => {
      const patch = trackersPatch(q.data!, f);
      return Object.keys(patch).length ? endpoints.admin.updateTrackers(patch) : Promise.resolve(q.data!);
    },
    onSuccess: (d) => { qc.setQueryData(['admin-trackers'], d); setF(trackersToForm(d)); setDirty(false); setPollUntil(Date.now() + 30_000); toast('ok', 'Tracker lists saved'); },
  });
  const refresh = useMutation({
    mutationFn: endpoints.admin.refreshTrackers,
    onSuccess: (d) => { qc.setQueryData(['admin-trackers'], d); setPollUntil(Date.now() + 30_000); toast('ok', 'Refresh requested'); },
  });
  const d = q.data;
  return (
    <section data-testid="tracker-lists" className="card mt-6 max-w-2xl space-y-4" aria-label="Tracker lists">
      <h2 className="text-sm font-semibold">Tracker lists</h2>
      <ErrorNote error={q.error} />
      {d && (
        <>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Load extra BitTorrent trackers from plain-text lists (one tracker per line) and add them to new downloads. Only public https list hosts and
            public trackers are accepted. Trackers learn the VPN exit IP and the infohash of every download, so a third-party list widens who learns what you download.
          </p>
          {!d.enabled && <p role="status" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">Extra trackers are switched off (Advanced: torrent engine, "Add extra trackers to new torrents"). Lists are not fetched.</p>}
          <form className="space-y-4" aria-label="Tracker list settings" onSubmit={(e) => { e.preventDefault(); if (!problem) save.mutate(); }}>
            <Field label="List URLs (one per line, https, at most 5)">
              {(id) => <textarea id={id} rows={3} className="input font-mono" spellCheck={false} value={f.urls} onChange={(e) => edit({ urls: e.target.value })} />}
            </Field>
            <Button type="button" size="sm" onClick={() => edit({ urls: addUrlLine(f.urls, NGOSANG_ALL) })}>Use ngosang/trackerslist (all)</Button>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Refresh every (hours, 1-720)">
                {(id) => <input id={id} type="number" min={1} max={720} step={1} className="input" value={f.refreshHours} onChange={(e) => edit({ refreshHours: e.target.value })} />}
              </Field>
              <Field label="Max trackers from lists (1-1000)">
                {(id) => <input id={id} type="number" min={1} max={1000} step={1} className="input" value={f.maxTrackers} onChange={(e) => edit({ maxTrackers: e.target.value })} />}
              </Field>
            </div>
            {problem && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{problem}</p>}
            <ErrorNote error={save.error} />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="primary" data-testid="tracker-lists-save" disabled={save.isPending || !!problem || !dirty}>{save.isPending ? 'Saving...' : 'Save tracker lists'}</Button>
              <Button type="button" data-testid="tracker-lists-refresh" disabled={refresh.isPending || dirty || !d.enabled || d.urls.length === 0 || !!d.refreshRequestedAt} onClick={() => refresh.mutate()}>
                {d.refreshRequestedAt ? 'Refreshing...' : 'Refresh now'}
              </Button>
            </div>
            <ErrorNote error={refresh.error} />
          </form>
          {d.lists.length > 0 && (
            <table className="w-full text-left text-sm">
              <thead><tr><th className="pb-1 pr-2">List</th><th className="pb-1 pr-2">Trackers</th><th className="pb-1 pr-2">Updated</th><th className="pb-1">Status</th></tr></thead>
              <tbody>
                {d.lists.map((l) => (
                  <tr key={l.url} data-testid="tracker-list-row" className="align-top">
                    <td className="break-all py-1 pr-2 font-mono text-xs">{l.url}</td>
                    <td className="py-1 pr-2">{l.trackerCount}</td>
                    <td className="py-1 pr-2">{l.lastFetchedAt ? formatAge(l.lastFetchedAt) : l.lastAttemptAt ? 'never' : 'pending'}</td>
                    <td className={l.error ? 'py-1 text-red-700 dark:text-red-400' : 'py-1 text-green-700 dark:text-green-400'}>
                      {l.error ? `${l.error}${l.trackerCount ? ' (keeping the previous list)' : ''}` : l.lastAttemptAt ? 'OK' : 'Waiting for the worker'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p data-testid="tracker-lists-total" className="text-sm">
            Trackers given to the torrent engine: <strong>{d.effectiveCount}</strong> ({d.manualCount} manual, the rest from the lists).
          </p>
          <p className="hint">
            Applies to torrents added after the list is applied; running downloads are not changed. Private torrents never get these trackers: the engine skips them
            for .torrent files, and for magnet links the worker removes them again as soon as the engine knows the torrent is private.
          </p>
        </>
      )}
    </section>
  );
}

/** Collapsed by default; fetches only once opened. */
function EngineSettings() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const q = useQuery({ queryKey: ['admin-engine-settings'], queryFn: endpoints.admin.engineSettings, enabled: open, retry: false });
  const [f, setF] = useState<EngineForm | null>(null);
  useEffect(() => { if (q.data) setF(engineToForm(q.data)); }, [q.data]);
  const unreachable = q.error instanceof ApiError && q.error.code === 'engine_unavailable';

  const save = useMutation({
    mutationFn: () => {
      const patch = enginePatch(q.data!, f!);
      if (!Object.keys(patch).length) return Promise.resolve(q.data!);
      return endpoints.admin.updateEngineSettings(patch);
    },
    onMutate: () => setSaved(false),
    onSuccess: (d) => { qc.setQueryData(['admin-engine-settings'], d); setF(engineToForm(d)); setSaved(true); },
  });

  const num = (k: (typeof NUM_KEYS)[number], label: string, hint?: string, min?: number) => (
    <Field label={label} hint={hint}>
      {(id) => <input id={id} type="number" step={1} min={min} className="input" value={String(f![k])} disabled={k === 'listenPort' && !!f!.randomPort}
        onChange={(e) => { setSaved(false); setF((s) => ({ ...s!, [k]: e.target.value })); }} />}
    </Field>
  );
  const chk = (k: keyof EngineSettingsDto, label: string) => (
    <Check label={label} checked={!!f![k]} onChange={(v) => { setSaved(false); setF((s) => ({ ...s!, [k]: v })); }} />
  );
  const legend = 'mb-2 text-sm font-semibold';

  return (
    <details data-testid="engine-settings" className="card mt-6 max-w-xl" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer text-sm font-semibold">Advanced: torrent engine</summary>
      <div className="mt-4 space-y-4">
        {open && q.isLoading && <Spinner />}
        {unreachable && <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">Torrent engine is not reachable. Check that the qBittorrent container is running, then <button type="button" className="underline" onClick={() => q.refetch()}>retry</button>.</div>}
        {q.error && !unreachable && <ErrorNote error={q.error} />}
        {q.data && f && (
          <form className="space-y-5" aria-label="Torrent engine settings" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
            <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
              Warning: wrong values can slow or stall downloads. Only change these if you know what they do.
            </p>
            <fieldset className="space-y-3"><legend className={legend}>Speed</legend>
              {num('downloadLimitKBps', 'Download limit (KB/s, 0 = unlimited)', undefined, 0)}
              {num('uploadLimitKBps', 'Upload limit (KB/s, 0 = unlimited)', undefined, 0)}
            </fieldset>
            <fieldset className="space-y-3"><legend className={legend}>Connections</legend>
              {num('maxConnections', 'Max connections (-1 = unlimited)', undefined, -1)}
              {num('maxConnectionsPerTorrent', 'Max connections per torrent (-1 = unlimited)', undefined, -1)}
              {num('maxUploads', 'Max upload slots (-1 = unlimited)', undefined, -1)}
              {num('maxUploadsPerTorrent', 'Max upload slots per torrent (-1 = unlimited)', undefined, -1)}
            </fieldset>
            <fieldset className="space-y-3"><legend className={legend}>Queueing</legend>
              {chk('queueingEnabled', 'Enable torrent queueing')}
              {num('maxActiveDownloads', 'Max active downloads (-1 = unlimited)', undefined, -1)}
              {num('maxActiveUploads', 'Max active uploads (-1 = unlimited)', undefined, -1)}
              {num('maxActiveTorrents', 'Max active torrents (-1 = unlimited)', undefined, -1)}
            </fieldset>
            <fieldset className="space-y-3"><legend className={legend}>Peer discovery and privacy</legend>
              {chk('dht', 'DHT (distributed hash table)')}
              {chk('pex', 'PeX (peer exchange)')}
              {chk('lsd', 'LSD (local peer discovery)')}
              <Field label="Peer encryption">
                {(id) => (
                  <select id={id} className="input" value={String(f.encryption)} onChange={(e) => { setSaved(false); setF((s) => ({ ...s!, encryption: e.target.value })); }}>
                    <option value="prefer">Prefer encryption</option>
                    <option value="require">Require encryption</option>
                    <option value="disable">Disable encryption</option>
                  </select>
                )}
              </Field>
              {chk('anonymousMode', 'Anonymous mode')}
            </fieldset>
            <fieldset className="space-y-3"><legend className={legend}>Network</legend>
              {chk('randomPort', 'Use a random listen port')}
              {num('listenPort', 'Listen port (1024-65535)', 'Incoming port inside the VPN network namespace.', 1024)}
            </fieldset>
            <fieldset className="space-y-3"><legend className={legend}>Trackers</legend>
              {chk('addTrackersEnabled', 'Add extra trackers to new torrents')}
              <Field label="Manual extra trackers (one URL per line, max 100)" hint="http, https, udp, ws or wss URLs. Always added first; trackers from the lists above come after them.">
                {(id) => <textarea id={id} rows={4} className="input font-mono" value={String(f.addTrackers)} onChange={(e) => { setSaved(false); setF((s) => ({ ...s!, addTrackers: e.target.value })); }} />}
              </Field>
            </fieldset>
            <ErrorNote error={save.error} />
            {saved && <div role="status" className="text-sm text-green-700 dark:text-green-400">Engine settings saved</div>}
            <Button type="submit" variant="primary" data-testid="engine-save" disabled={save.isPending}>{save.isPending ? 'Saving...' : 'Save engine settings'}</Button>
          </form>
        )}
      </div>
    </details>
  );
}
