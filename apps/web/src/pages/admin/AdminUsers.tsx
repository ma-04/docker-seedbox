import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, Check, Empty, ErrorNote, PageHeader, Spinner, errMsg, useToast } from '../../components/ui';
import { endpoints, type UserDto } from '../../lib/api';
import { formatAge } from '../../lib/format';

function UserRow({ u }: { u: UserDto }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [limit, setLimit] = useState(u.maxActiveJobs == null ? '' : String(u.maxActiveJobs));
  const upd = useMutation({
    mutationFn: (b: { disabled?: boolean; maxActiveJobs?: number | null }) => endpoints.admin.updateUser(u.id, b),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin-users'] }); toast('ok', `Updated ${u.username}`); },
    onError: (e) => toast('error', errMsg(e)),
  });
  const parsed = limit.trim() === '' ? null : Number(limit);
  const dirty = parsed !== u.maxActiveJobs && (parsed === null || Number.isFinite(parsed));
  return (
    <tr data-testid="user-row">
      <td className="td font-medium">{u.username}</td>
      <td className="td">{u.email ?? '-'}</td>
      <td className="td">{u.isAdmin ? <Badge tone="brand">admin</Badge> : 'no'}</td>
      <td className="td">{u.activeJobs}</td>
      <td className="td">{formatAge(u.lastSeenAt)}</td>
      <td className="td"><Check label={`Disabled: ${u.username}`} checked={u.disabled} onChange={(v) => upd.mutate({ disabled: v })} /></td>
      <td className="td">
        <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); upd.mutate({ maxActiveJobs: parsed }); }}>
          <label className="sr-only" htmlFor={`max-${u.id}`}>Max active jobs for {u.username}</label>
          <input id={`max-${u.id}`} type="number" min={0} placeholder="default" className="input w-24" value={limit} onChange={(e) => setLimit(e.target.value)} />
          <Button type="submit" size="sm" disabled={!dirty || upd.isPending}>Save</Button>
        </form>
      </td>
    </tr>
  );
}

export default function AdminUsers() {
  const q = useQuery({ queryKey: ['admin-users'], queryFn: endpoints.admin.users });
  return (
    <>
      <PageHeader title="Users" />
      {q.isLoading ? <Spinner /> : q.error ? <ErrorNote error={q.error} /> : !q.data?.length ? <Empty>No users yet.</Empty> : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead><tr><th className="th">Username</th><th className="th">Email</th><th className="th">Admin</th><th className="th">Active jobs</th><th className="th">Last seen</th><th className="th">Disabled</th><th className="th">Max active jobs</th></tr></thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">{q.data.map((u) => <UserRow key={u.id} u={u} />)}</tbody>
          </table>
        </div>
      )}
    </>
  );
}
