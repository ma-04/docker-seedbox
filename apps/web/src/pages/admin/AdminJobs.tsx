import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { StateBadge } from '../../components/JobParts';
import { ConfirmButton, Empty, ErrorNote, PageHeader, Spinner, errMsg, useToast } from '../../components/ui';
import { endpoints } from '../../lib/api';
import { formatAge, formatBytes } from '../../lib/format';
import { displayName } from '../../lib/jobs';

export default function AdminJobs() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['admin-jobs'], queryFn: endpoints.admin.jobs, refetchInterval: 5000 });
  const del = useMutation({
    mutationFn: (id: number) => endpoints.admin.deleteJob(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-jobs'] }),
    onError: (e) => toast('error', errMsg(e)),
  });
  return (
    <>
      <PageHeader title="All jobs" />
      {q.isLoading ? <Spinner /> : q.error ? <ErrorNote error={q.error} /> : !q.data?.length ? <Empty>No jobs.</Empty> : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead><tr><th className="th">User</th><th className="th">Name</th><th className="th">State</th><th className="th">Destination</th><th className="th">Size</th><th className="th">Age</th><th className="th"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {q.data.map((j) => (
                <tr key={j.id} data-testid="admin-job-row" data-job-id={j.id} data-state={j.state}>
                  <td className="td">{j.user?.username ?? '-'}</td>
                  <td className="td max-w-xs break-all">{displayName(j)}{j.error && <div className="text-xs text-red-600 dark:text-red-400">{j.error}</div>}</td>
                  <td className="td"><StateBadge state={j.state} /></td>
                  <td className="td">{j.destination.name}</td>
                  <td className="td">{j.totalSize ? formatBytes(j.totalSize) : '-'}</td>
                  <td className="td">{formatAge(j.createdAt)}</td>
                  <td className="td text-right"><ConfirmButton label="Delete" confirmLabel="Yes, delete" onConfirm={() => del.mutate(j.id)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
