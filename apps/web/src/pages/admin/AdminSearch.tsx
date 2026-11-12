import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Badge, Button, Check, ErrorNote, PageHeader, Spinner, useToast } from '../../components/ui';
import { endpoints, type SearchAdminDto, type SearchCategoryId } from '../../lib/api';

function StatusCard({ s }: { s: SearchAdminDto }) {
  const rows: [string, string][] = [
    ['Backend', s.backend ?? '-'],
    ['Reachable', s.reachable ? 'yes' : 'no'],
    ['Configured indexers', s.indexerCount === null ? '-' : String(s.indexerCount)],
    ['FlareSolverr', s.flaresolverr === 'disabled' ? 'not enabled' : s.flaresolverr === 'ok' ? 'reachable' : 'not reachable'],
  ];
  return (
    <section className="card" aria-label="Search status" data-testid="search-status">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">Status</h2>
        {s.reachable ? <Badge tone="green" data-testid="search-reachable">reachable</Badge> : <Badge tone="red" data-testid="search-unreachable">unreachable</Badge>}
        {s.reachable && s.indexerCount === 0 && <Badge tone="amber">no indexers</Badge>}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm md:grid-cols-4">
        {rows.map(([k, v]) => (<div key={k}><dt className="text-xs text-slate-500">{k}</dt><dd className="font-medium" data-testid={`search-status-${k.toLowerCase().replace(/\s+/g, '-')}`}>{v}</dd></div>))}
      </dl>
      {s.error && <p className="mt-2 text-sm text-red-600 dark:text-red-400" role="alert">{s.error}</p>}
      {s.uiPath && (
        <p className="mt-3 text-sm">
          Indexers are managed in Jackett&apos;s own interface (admins only, through this site; its tracker traffic goes through the VPN):{' '}
          <a data-testid="jackett-link" href={s.uiPath} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-600 hover:underline">Open Jackett</a>
        </p>
      )}
    </section>
  );
}

function CategoriesCard({ s }: { s: SearchAdminDto }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  useEffect(() => { setEnabled(Object.fromEntries(s.categories.map((c) => [c.id, c.enabled]))); }, [s.categories]);
  const save = useMutation({
    mutationFn: () => endpoints.admin.updateSearch({ disabledCategories: s.categories.filter((c) => !enabled[c.id]).map((c) => c.id as SearchCategoryId) }),
    onSuccess: (d) => { qc.setQueryData(['admin-search'], d); qc.invalidateQueries({ queryKey: ['search-meta'] }); toast('ok', 'Search categories saved'); },
  });
  return (
    <section className="card space-y-3" aria-label="Search categories" data-testid="search-categories">
      <h2 className="text-base font-semibold">Categories</h2>
      <p className="text-sm text-slate-600 dark:text-slate-300">Users can search only the enabled categories; results in a disabled category are never shown, also not under &ldquo;All&rdquo;.</p>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        {s.categories.map((c) => (
          <Check key={c.id} label={c.label} checked={!!enabled[c.id]} onChange={(v) => setEnabled((e) => ({ ...e, [c.id]: v }))} />
        ))}
      </div>
      <ErrorNote error={save.error} />
      <Button variant="primary" data-testid="search-categories-save" disabled={save.isPending} onClick={() => save.mutate()}>Save categories</Button>
    </section>
  );
}

export default function AdminSearch() {
  const q = useQuery({ queryKey: ['admin-search'], queryFn: endpoints.admin.search, refetchInterval: 30_000 });
  if (q.isLoading) return <Spinner label="Loading search status" />;
  if (q.error) return <ErrorNote error={q.error} />;
  const s = q.data!;
  return (
    <>
      <PageHeader title="Search" />
      <div className="space-y-4">
        {s.enabled ? <StatusCard s={s} /> : (
          <section className="card text-sm" data-testid="search-off">
            Torrent search is not enabled. Run <code>./setup.sh --search</code> on the server to add Jackett (it runs inside the VPN namespace).
          </section>
        )}
        <CategoriesCard s={s} />
      </div>
    </>
  );
}
