import { useState, type FormEvent } from 'react';
import type { DestinationDto } from '../lib/api';
import type { DestinationType } from '../../../api/src/lib/types';
import { Button, Check, ErrorNote, Field } from './ui';

export interface DestinationSubmit {
  name: string;
  type: DestinationType;
  config: Record<string, unknown>;
  rcloneConfig?: string;
  enabled: boolean;
  isDefault: boolean;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

export function randomKeyHex(bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Build the wire config from form values. On create, empty optional strings are omitted so rclone paste can fill them. */
export function buildConfig(type: DestinationType, v: Record<string, string>, bools: { forcePathStyle: boolean }, editing: boolean): Record<string, unknown> {
  const keys: Record<DestinationType, string[]> = {
    s3: ['endpoint', 'region', 'bucket', 'prefix', 'accessKeyId', 'secretAccessKey', 'publicBaseUrl'],
    gdrive: ['clientId', 'clientSecret', 'refreshToken', 'rootFolderId', 'sharing', 'proxyBaseUrl', 'proxySigningKey'],
    local: ['subdir', 'publicBaseUrl'],
  };
  const out: Record<string, unknown> = {};
  for (const k of keys[type]) {
    const val = (v[k] ?? '').trim();
    if (val !== '' || editing) out[k] = val;
  }
  if (type === 's3') out.forcePathStyle = bools.forcePathStyle;
  const ttl = (v.linkTtlSeconds ?? '').trim();
  if (ttl !== '') out.linkTtlSeconds = Number(ttl);
  return out;
}

export function DestinationForm({ initial, types, admin, pending, error, onSubmit, onCancel }: {
  initial?: DestinationDto;
  types: DestinationType[];
  admin: boolean;
  pending: boolean;
  error: unknown;
  onSubmit: (v: DestinationSubmit) => void;
  onCancel: () => void;
}) {
  const editing = !!initial;
  const c = initial?.config ?? {};
  const [type, setType] = useState<DestinationType>(initial?.type ?? types[0] ?? 's3');
  const [name, setName] = useState(initial?.name ?? '');
  const [v, setV] = useState<Record<string, string>>(() => ({
    endpoint: str(c.endpoint), region: str(c.region), bucket: str(c.bucket), prefix: str(c.prefix),
    accessKeyId: str(c.accessKeyId), secretAccessKey: str(c.secretAccessKey), publicBaseUrl: str(c.publicBaseUrl),
    linkTtlSeconds: str(c.linkTtlSeconds), clientId: str(c.clientId), clientSecret: str(c.clientSecret),
    refreshToken: str(c.refreshToken), rootFolderId: str(c.rootFolderId), sharing: str(c.sharing) || 'none',
    proxyBaseUrl: str(c.proxyBaseUrl), proxySigningKey: str(c.proxySigningKey), subdir: str(c.subdir),
  }));
  const [forcePathStyle, setForcePathStyle] = useState(c.forcePathStyle === true);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [isDefault, setIsDefault] = useState(initial?.isDefault ?? false);
  const [rclone, setRclone] = useState('');
  const set = (k: string) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));
  const text = (label: string, k: string, o: { hint?: string; type?: string; required?: boolean; placeholder?: string } = {}) => (
    <Field label={label} hint={o.hint}>
      {(id) => <input id={id} className="input" type={o.type ?? 'text'} required={o.required} placeholder={o.placeholder} value={v[k] ?? ''} onChange={set(k)} autoComplete="off" />}
    </Field>
  );
  const secret = (label: string, k: string, hint?: string) => text(label, k, { type: 'password', hint: hint ?? (editing ? 'Leave as ******** to keep the stored value.' : undefined) });
  const ttl = text('Link TTL (seconds)', 'linkTtlSeconds', { type: 'number', hint: '0 = links never expire.' });
  const hasRclone = admin && type !== 'local' && !editing;
  const usingRclone = hasRclone && rclone.trim() !== '';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit({
      name: name.trim(), type, config: buildConfig(type, v, { forcePathStyle }, editing),
      rcloneConfig: usingRclone ? rclone : undefined, enabled, isDefault,
    });
  };

  const s3Fields = (
    <>
      {text('Endpoint', 'endpoint', { required: !usingRclone, placeholder: 'https://s3.example.com' })}
      {text('Region', 'region', { required: !usingRclone, placeholder: 'us-east-1' })}
      {text('Bucket', 'bucket', { required: true })}
      {text('Prefix', 'prefix', { hint: 'Optional key prefix inside the bucket.' })}
      {text('Access key ID', 'accessKeyId', { required: !usingRclone })}
      {secret('Secret access key', 'secretAccessKey')}
      <div className="self-end pb-2"><Check label="Force path style" checked={forcePathStyle} onChange={setForcePathStyle} /></div>
      {text('Public base URL', 'publicBaseUrl', { hint: 'If set, links are base URL + key; otherwise presigned URLs are used.' })}
      {ttl}
    </>
  );

  return (
    <form onSubmit={submit} aria-label={editing ? `Edit destination ${initial!.name}` : 'New destination'} className="card space-y-4">
      <h3 className="text-base font-semibold">{editing ? `Edit ${initial!.name}` : 'New destination'}</h3>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Name">
          {(id) => <input id={id} className="input" required value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        {types.length > 1 && !editing && (
          <Field label="Type">
            {(id) => (
              <select id={id} className="input" value={type} onChange={(e) => setType(e.target.value as DestinationType)}>
                {types.map((t) => <option key={t} value={t}>{t === 'gdrive' ? 'Google Drive' : t === 's3' ? 'S3-compatible' : 'Local folder'}</option>)}
              </select>
            )}
          </Field>
        )}
        {type === 's3' && s3Fields}
        {type === 'gdrive' && (
          <>
            {text('Client ID', 'clientId', { required: !usingRclone })}
            {secret('Client secret', 'clientSecret')}
            {secret('Refresh token', 'refreshToken')}
            {text('Root folder ID', 'rootFolderId', { required: !usingRclone })}
            <Field label="Sharing" hint="How each user's folder is shared.">
              {(id) => (
                <select id={id} className="input" value={v.sharing} onChange={set('sharing')}>
                  <option value="none">none</option><option value="anyone">anyone</option><option value="user">user</option>
                </select>
              )}
            </Field>
            {text('Proxy base URL', 'proxyBaseUrl', { placeholder: 'https://drive.example.com' })}
            <Field label="Proxy signing key" hint={editing ? 'Leave as ******** to keep the stored value.' : 'Must equal the Worker SIGNING_KEY secret.'}>
              {(id) => (
                <div className="flex gap-2">
                  <input id={id} className="input font-mono" type="password" autoComplete="off" value={v.proxySigningKey} onChange={set('proxySigningKey')} />
                  <Button onClick={() => setV((s) => ({ ...s, proxySigningKey: randomKeyHex() }))}>Generate</Button>
                </div>
              )}
            </Field>
            {ttl}
          </>
        )}
        {type === 'local' && (
          <>
            {text('Subdirectory', 'subdir', { hint: 'Optional folder below the library root.' })}
            {text('Public base URL', 'publicBaseUrl', { hint: 'Defaults to the download host: the app host (/dl/), or FILES_HOST when one is set.'})}
            {ttl}
          </>
        )}
      </div>
      {hasRclone && (
        <Field label="Paste rclone config section" hint="Optional. Paste the [remote] block from rclone.conf (type drive or s3) to fill in credentials; explicit fields above take priority.">
          {(id) => <textarea id={id} rows={5} className="input font-mono" spellCheck={false} placeholder={'[remote]\ntype = drive\nclient_id = ...'} value={rclone} onChange={(e) => setRclone(e.target.value)} />}
        </Field>
      )}
      {admin && (
        <div className="flex flex-wrap gap-6">
          <Check label="Enabled" checked={enabled} onChange={setEnabled} />
          <Check label="Default destination" checked={isDefault} onChange={setIsDefault} />
        </div>
      )}
      <ErrorNote error={error} />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={pending}>{pending ? 'Saving...' : editing ? 'Save changes' : 'Create destination'}</Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
