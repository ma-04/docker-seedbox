import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button, ErrorNote, Field, PageHeader, Spinner, useToast } from '../../components/ui';
import { endpoints, type SettingsDto } from '../../lib/api';
import { bytesToGb, gbToBytes } from '../../lib/format';

export default function AdminSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['admin-settings'], queryFn: endpoints.admin.settings });
  const [f, setF] = useState({ maxJobs: '', maxGb: '', minFreeGb: '', ratio: '' });
  useEffect(() => {
    const d = q.data;
    if (d) setF({
      maxJobs: String(d['limits.maxActiveJobsPerUser']), maxGb: String(bytesToGb(d['limits.maxTorrentBytes'])),
      minFreeGb: String(bytesToGb(d['limits.minFreeDiskBytes'])), ratio: String(d['seeding.ratio']),
    });
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => {
      const cur = q.data!;
      const patch: Partial<SettingsDto> = {};
      const jobs = Number(f.maxJobs), max = gbToBytes(Number(f.maxGb)), free = gbToBytes(Number(f.minFreeGb)), ratio = Number(f.ratio);
      if (jobs !== cur['limits.maxActiveJobsPerUser']) patch['limits.maxActiveJobsPerUser'] = jobs;
      if (max !== cur['limits.maxTorrentBytes']) patch['limits.maxTorrentBytes'] = max;
      if (free !== cur['limits.minFreeDiskBytes']) patch['limits.minFreeDiskBytes'] = free;
      if (ratio !== cur['seeding.ratio']) patch['seeding.ratio'] = ratio;
      if (!Object.keys(patch).length) return Promise.resolve(cur);
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
          <ErrorNote error={save.error} />
          <Button type="submit" variant="primary" disabled={save.isPending}>{save.isPending ? 'Saving...' : 'Save settings'}</Button>
        </form>
      )}
    </>
  );
}
