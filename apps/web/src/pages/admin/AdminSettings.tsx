import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button, Check, ErrorNote, Field, PageHeader, Spinner, useToast } from '../../components/ui';
import { ApiError, endpoints, type EngineSettingsDto } from '../../lib/api';
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
      <EngineSettings />
    </>
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
              <Field label="Extra trackers (one URL per line, max 50)" hint="http, https, udp, ws or wss URLs.">
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
