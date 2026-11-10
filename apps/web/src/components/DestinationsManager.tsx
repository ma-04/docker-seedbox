import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { endpoints, type DestinationDto, type TestResultDto } from '../lib/api';
import { DestinationForm, type DestinationSubmit } from './DestinationForm';
import { Badge, Button, ConfirmButton, Empty, ErrorNote, Spinner, errMsg, useToast } from './ui';

const TYPE_LABEL = { gdrive: 'Google Drive', s3: 'S3-compatible', local: 'Local folder' } as const;

function DestinationCard({ d, editable, admin, onEdit }: { d: DestinationDto; editable: boolean; admin: boolean; onEdit: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const api = admin ? endpoints.admin : endpoints;
  const [result, setResult] = useState<TestResultDto | null>(null);
  const invalidate = () => { qc.invalidateQueries({ queryKey: [admin ? 'admin-destinations' : 'destinations'] }); qc.invalidateQueries({ queryKey: ['destinations'] }); };
  const test = useMutation({ mutationFn: () => api.testDestination(d.id), onMutate: () => setResult(null), onSuccess: setResult, onError: (e) => setResult({ ok: false, message: errMsg(e) }) });
  const del = useMutation({ mutationFn: () => api.deleteDestination(d.id), onSuccess: () => { invalidate(); toast('ok', `Deleted ${d.name}`); }, onError: (e) => toast('error', errMsg(e)) });
  const patch = useMutation({ mutationFn: (b: { enabled?: boolean; isDefault?: boolean }) => api.updateDestination(d.id, b), onSuccess: invalidate, onError: (e) => toast('error', errMsg(e)) });
  return (
    <li className="card" data-testid="destination-row" data-destination-id={d.id}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{d.name}</h3>
        <Badge>{TYPE_LABEL[d.type]}</Badge>
        {d.shared && <Badge tone="brand">shared</Badge>}
        {d.isDefault && <Badge tone="green">default</Badge>}
        {!d.enabled && <Badge tone="amber">disabled</Badge>}
      </div>
      {editable ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={onEdit}>Edit</Button>
          <Button size="sm" disabled={test.isPending} onClick={() => test.mutate()}>{test.isPending ? 'Testing...' : 'Test'}</Button>
          {admin && <Button size="sm" variant="ghost" disabled={patch.isPending} onClick={() => patch.mutate({ enabled: !d.enabled })}>{d.enabled ? 'Disable' : 'Enable'}</Button>}
          {admin && !d.isDefault && <Button size="sm" variant="ghost" disabled={patch.isPending} onClick={() => patch.mutate({ isDefault: true })}>Make default</Button>}
          <ConfirmButton label="Delete" confirmLabel="Yes, delete" onConfirm={() => del.mutate()} disabled={del.isPending} />
        </div>
      ) : <p className="mt-2 text-xs text-slate-500">Managed by an administrator (read-only).</p>}
      {result && <p role="status" data-testid="test-result" className={result.ok ? 'mt-2 text-sm text-emerald-700 dark:text-emerald-400' : 'mt-2 text-sm text-red-600 dark:text-red-400'}>{result.ok ? 'OK' : 'Failed'}: {result.message}</p>}
    </li>
  );
}

export function DestinationsManager({ admin }: { admin: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const api = admin ? endpoints.admin : endpoints;
  const q = useQuery({ queryKey: [admin ? 'admin-destinations' : 'destinations'], queryFn: api.destinations });
  const [mode, setMode] = useState<{ kind: 'none' } | { kind: 'new' } | { kind: 'edit'; d: DestinationDto }>({ kind: 'none' });
  const types = admin ? (['gdrive', 's3', 'local'] as const) : (['s3'] as const);

  const save = useMutation({
    mutationFn: (s: DestinationSubmit) => {
      if (mode.kind === 'edit') return api.updateDestination(mode.d.id, { name: s.name, config: s.config, ...(admin ? { enabled: s.enabled, isDefault: s.isDefault } : {}) });
      return api.createDestination({ name: s.name, type: s.type, config: s.config, ...(admin ? { rcloneConfig: s.rcloneConfig, enabled: s.enabled, isDefault: s.isDefault } : {}) });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-destinations'] });
      qc.invalidateQueries({ queryKey: ['destinations'] });
      toast('ok', 'Destination saved');
      setMode({ kind: 'none' });
    },
  });

  const list = q.data ?? [];
  return (
    <div className="space-y-4">
      {admin && (
        <div className="card border-sky-300 bg-sky-50 text-sm dark:border-sky-900 dark:bg-sky-950" role="note" aria-label="Google Drive proxy help">
          <p className="font-semibold">Google Drive downloads need a proxy</p>
          <p className="mt-1">
            Shared Google Drive files are served through a small Cloudflare Worker so users never need Drive access. Deploy
            <code className="mx-1 rounded bg-slate-200 px-1 dark:bg-slate-800">apps/drive-proxy</code>, set its URL as the <em>Proxy base URL</em>, and use the
            same value as the <em>Proxy signing key</em> and the Worker's <code className="mx-1 rounded bg-slate-200 px-1 dark:bg-slate-800">SIGNING_KEY</code> secret.
          </p>
        </div>
      )}
      <div className="flex justify-end">
        {mode.kind === 'none' && <Button variant="primary" onClick={() => { save.reset(); setMode({ kind: 'new' }); }}>{admin ? 'Add shared destination' : 'Add S3 destination'}</Button>}
      </div>
      {mode.kind !== 'none' && (
        <DestinationForm key={mode.kind === 'edit' ? mode.d.id : 'new'} initial={mode.kind === 'edit' ? mode.d : undefined} types={[...types]} admin={admin}
          pending={save.isPending} error={save.error} onSubmit={(s) => save.mutate(s)} onCancel={() => setMode({ kind: 'none' })} />
      )}
      {q.isLoading ? <Spinner label="Loading destinations" /> : q.error ? <ErrorNote error={q.error} /> : list.length === 0 ? (
        <Empty>No destinations yet.</Empty>
      ) : (
        <ul className="space-y-3" aria-label="Destinations">
          {list.map((d) => <DestinationCard key={d.id} d={d} admin={admin} editable={admin || !d.shared} onEdit={() => { save.reset(); setMode({ kind: 'edit', d }); }} />)}
        </ul>
      )}
    </div>
  );
}
