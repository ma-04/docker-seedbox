import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Badge, Button, Check, ConfirmButton, Empty, ErrorNote, Field, PageHeader, Spinner, errMsg, useToast } from '../../components/ui';
import { endpoints, type SettingsDto } from '../../lib/api';
import { formatAge, formatDuration } from '../../lib/format';

function StatusCard() {
  const q = useQuery({ queryKey: ['vpn-status'], queryFn: endpoints.admin.vpnStatus, refetchInterval: 5000 });
  const configs = useQuery({ queryKey: ['vpn-configs'], queryFn: endpoints.admin.vpnConfigs });
  if (q.isLoading) return <Spinner label="Loading VPN status" />;
  if (q.error) return <ErrorNote error={q.error} />;
  const s = q.data!;
  const activeName = s.name ?? configs.data?.find((c) => c.id === s.activeConfigId)?.name ?? null;
  const rows: [string, string][] = [
    ['Mode', s.mode],
    ['Connected', s.reachable ? (s.connected ? 'yes' : 'no') : 'unknown'],
    ['Active config', activeName ?? 'none'],
    ['Public IP', s.publicIp ?? '-'],
    ['MTU', s.mtu == null ? '-' : String(s.mtu)],
    ['Last handshake', s.lastHandshakeSec == null ? '-' : `${formatDuration(s.lastHandshakeSec)} ago`],
    ['Reachable', s.reachable ? 'yes' : 'no'],
  ];
  return (
    <section className="card" aria-label="VPN status" data-testid="vpn-status">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-base font-semibold">Status</h2>
        {!s.reachable ? <Badge tone="red">VPN service unreachable</Badge> : s.connected ? <Badge tone="green">connected</Badge> : <Badge tone="amber">disconnected</Badge>}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm md:grid-cols-3">
        {rows.map(([k, v]) => (<div key={k}><dt className="text-xs text-slate-500">{k}</dt><dd className="font-medium">{v}</dd></div>))}
      </dl>
    </section>
  );
}

function SettingsCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['admin-settings'], queryFn: endpoints.admin.settings });
  const [mode, setMode] = useState<SettingsDto['vpn.mode']>('off');
  const [rotation, setRotation] = useState<SettingsDto['vpn.rotation']>('manual');
  const [minutes, setMinutes] = useState('360');
  useEffect(() => {
    if (!q.data) return;
    setMode(q.data['vpn.mode']); setRotation(q.data['vpn.rotation']); setMinutes(String(q.data['vpn.rotationMinutes']));
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => {
      const cur = q.data!;
      const patch: Partial<SettingsDto> = {};
      if (mode !== cur['vpn.mode']) patch['vpn.mode'] = mode;
      if (rotation !== cur['vpn.rotation']) patch['vpn.rotation'] = rotation;
      if (rotation === 'interval' && Number(minutes) !== cur['vpn.rotationMinutes']) patch['vpn.rotationMinutes'] = Number(minutes);
      return endpoints.admin.updateSettings(patch);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin-settings'] }); qc.invalidateQueries({ queryKey: ['vpn-status'] }); toast('ok', 'VPN settings saved'); },
  });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} />;
  return (
    <form className="card space-y-3" aria-label="VPN settings" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
      <h2 className="text-base font-semibold">VPN mode and rotation</h2>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="VPN mode" hint="Required: torrents only run while the tunnel is up (kill switch).">
          {(id) => <select id={id} className="input" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}><option value="off">off</option><option value="required">required</option></select>}
        </Field>
        <Field label="Rotation">
          {(id) => (
            <select id={id} className="input" value={rotation} onChange={(e) => setRotation(e.target.value as typeof rotation)}>
              <option value="manual">manual</option><option value="interval">interval</option><option value="on-failure">on failure</option>
            </select>
          )}
        </Field>
        {rotation === 'interval' && (
          <Field label="Rotation interval (minutes)">
            {(id) => <input id={id} type="number" min={1} className="input" value={minutes} onChange={(e) => setMinutes(e.target.value)} />}
          </Field>
        )}
      </div>
      <ErrorNote error={save.error} />
      <Button type="submit" variant="primary" disabled={save.isPending}>{save.isPending ? 'Saving...' : 'Save VPN settings'}</Button>
    </form>
  );
}

function AddConfig() {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const add = useMutation({
    mutationFn: () => endpoints.admin.createVpnConfig({ name: name.trim(), config: text }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['vpn-configs'] }); setName(''); setText(''); toast('ok', 'VPN config added'); },
  });
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setText(await f.text());
    setName((n) => n || f.name.replace(/\.conf$/i, ''));
  };
  return (
    <form className="card space-y-3" aria-label="Add VPN config" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
      <h3 className="text-base font-semibold">Add a WireGuard config</h3>
      <p className="text-xs text-slate-500">Config contents contain private keys. They are stored encrypted and are never shown again after upload.</p>
      <Field label="Config name">{(id) => <input id={id} className="input" required value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      <Field label="WireGuard config file (.conf)">
        {(id) => <input id={id} data-testid="vpn-file" type="file" accept=".conf,text/plain" onChange={(e) => void onFile(e.target.files?.[0])} className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-slate-200 file:px-3 file:py-1.5 file:text-sm file:font-medium dark:file:bg-slate-700" />}
      </Field>
      <Field label="Config text" hint="Paste the wg-quick config here, or choose a file above.">
        {(id) => <textarea id={id} data-testid="vpn-text" rows={6} required className="input font-mono" spellCheck={false} autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} placeholder="[Interface]&#10;PrivateKey = ...&#10;[Peer]&#10;..." />}
      </Field>
      <ErrorNote error={add.error} />
      <Button type="submit" variant="primary" disabled={add.isPending}>{add.isPending ? 'Uploading...' : 'Add config'}</Button>
    </form>
  );
}

function Configs() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['vpn-configs'], queryFn: endpoints.admin.vpnConfigs, refetchInterval: 5000 });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['vpn-configs'] }); qc.invalidateQueries({ queryKey: ['vpn-status'] }); };
  const toggle = useMutation({ mutationFn: (v: { id: number; enabled: boolean }) => endpoints.admin.updateVpnConfig(v.id, { enabled: v.enabled }), onSuccess: refresh, onError: (e) => toast('error', errMsg(e)) });
  const del = useMutation({ mutationFn: (id: number) => endpoints.admin.deleteVpnConfig(id), onSuccess: refresh, onError: (e) => toast('error', errMsg(e)) });
  const rotate = useMutation({ mutationFn: (id?: number) => endpoints.admin.vpnRotate(id), onSuccess: () => { refresh(); toast('ok', 'VPN switch requested'); }, onError: (e) => toast('error', errMsg(e)) });
  return (
    <section className="space-y-3" aria-label="VPN configs">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Configs</h2>
        <Button disabled={rotate.isPending} onClick={() => rotate.mutate(undefined)}>Rotate now</Button>
      </div>
      {q.isLoading ? <Spinner /> : q.error ? <ErrorNote error={q.error} /> : !q.data?.length ? <Empty>No VPN configs yet. Add one below.</Empty> : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead><tr><th className="th">Name</th><th className="th">Endpoint</th><th className="th">Enabled</th><th className="th">Last used</th><th className="th">Last error</th><th className="th"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {q.data.map((c) => (
                <tr key={c.id} data-testid="vpn-config-row">
                  <td className="td font-medium">{c.name} {c.active && <Badge tone="green">active</Badge>}</td>
                  <td className="td">{c.endpointHost ?? '-'}</td>
                  <td className="td"><Check label={`Enabled: ${c.name}`} checked={c.enabled} onChange={(v) => toggle.mutate({ id: c.id, enabled: v })} /></td>
                  <td className="td">{formatAge(c.lastUsedAt)}</td>
                  <td className="td max-w-xs break-words text-red-600 dark:text-red-400">{c.lastError ?? ''}</td>
                  <td className="td whitespace-nowrap text-right">
                    <Button size="sm" disabled={rotate.isPending || !c.enabled} onClick={() => rotate.mutate(c.id)} aria-label={`Connect ${c.name}`}>Connect</Button>
                    <ConfirmButton label="Delete" confirmLabel="Yes, delete" onConfirm={() => del.mutate(c.id)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function AdminVpn() {
  return (
    <>
      <PageHeader title="VPN" />
      <div className="space-y-6">
        <StatusCard />
        <SettingsCard />
        <Configs />
        <AddConfig />
      </div>
    </>
  );
}
