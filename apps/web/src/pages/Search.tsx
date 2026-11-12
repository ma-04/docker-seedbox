import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Button, Empty, ErrorNote, Field, PageHeader, Spinner, cx, useToast } from '../components/ui';
import { ApiError, endpoints, type JobDto, type SearchMetaDto, type SearchResultDto } from '../lib/api';
import { formatAge, formatBytes } from '../lib/format';
import { useDestinations } from '../lib/hooks';
import { mergeJob } from '../lib/jobs';
import { nextSort, queryProblem, sortResults, type SortDir, type SortKey } from '../lib/search';

interface Submitted { q: string; cat: string; indexer: string }

/** Choose a destination for one result and add it (the same destinations and rules as the Downloads add form). */
function AddDialog({ result, onClose }: { result: SearchResultDto; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const dests = useDestinations();
  const options = useMemo(() => (dests.data ?? []).filter((d) => d.enabled), [dests.data]);
  const [destId, setDestId] = useState<number | null>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (destId === null && options.length) setDestId((options.find((d) => d.isDefault) ?? options[0])!.id);
  }, [options, destId]);
  useEffect(() => { selectRef.current?.focus(); }, [options.length]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const add = useMutation({
    mutationFn: () => {
      if (destId === null) throw new Error('Choose a destination first');
      return endpoints.searchAdd(result.token, destId);
    },
    onSuccess: (job: JobDto) => {
      qc.setQueryData<JobDto[]>(['jobs'], (old) => mergeJob(old, job));
      qc.invalidateQueries({ queryKey: ['jobs'] });
      toast('ok', 'Download added');
      onClose();
    },
  });
  const err = add.error instanceof ApiError && add.error.status === 410 ? new Error('This result has expired. Search again and retry.') : add.error;
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-slate-900/40 p-4 md:items-center" onClick={onClose}>
      <form role="dialog" aria-modal="true" aria-labelledby="add-result-title" data-testid="search-add-dialog"
        className="card w-full max-w-md space-y-3" onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
        <h2 id="add-result-title" className="text-base font-semibold">Add download</h2>
        <p className="break-all text-sm text-slate-600 dark:text-slate-300">{result.title}</p>
        <Field label="Destination">
          {(id) => (
            <select id={id} ref={selectRef} data-testid="search-destination" className="input" value={destId ?? ''} onChange={(e) => setDestId(Number(e.target.value))} disabled={!options.length}>
              {options.map((d) => <option key={d.id} value={d.id}>{d.name}{d.shared ? ' (shared)' : ''}</option>)}
            </select>
          )}
        </Field>
        {!dests.isLoading && !options.length && <p className="text-sm text-amber-700 dark:text-amber-400">No destination available. Add one on the Storage page or ask an admin.</p>}
        <ErrorNote error={err ?? dests.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" data-testid="search-add-confirm" disabled={add.isPending || !options.length}>{add.isPending ? 'Adding...' : 'Add download'}</Button>
        </div>
      </form>
    </div>
  );
}

function SortHeader({ k, label, sort, onSort }: { k: SortKey; label: string; sort: { key: SortKey; dir: SortDir }; onSort: (k: SortKey) => void }) {
  const active = sort.key === k;
  return (
    <th scope="col" className="px-2 py-2 text-right" aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" data-testid={`sort-${k}`} onClick={() => onSort(k)} className={cx('font-semibold hover:underline', active && 'text-brand-600')}>
        {label}{active ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
      </button>
    </th>
  );
}

function Results({ s, meta }: { s: Submitted; meta: SearchMetaDto }) {
  const q = useQuery({ queryKey: ['search', s], queryFn: () => endpoints.search(s.q, s.cat, s.indexer), retry: false, staleTime: 60_000 });
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'seeders', dir: 'desc' });
  const [adding, setAdding] = useState<SearchResultDto | null>(null);
  const labels = useMemo(() => Object.fromEntries(meta.categories.map((c) => [c.id, c.label])), [meta.categories]);
  const rows = useMemo(() => sortResults(q.data?.results ?? [], sort.key, sort.dir), [q.data, sort]);
  if (q.isLoading) return <Spinner label="Searching" />;
  if (q.error) return <ErrorNote error={q.error} />;
  if (!rows.length) return <Empty><span data-testid="search-empty">No results for &ldquo;{s.q}&rdquo;. Try other words or another category.</span></Empty>;
  return (
    <>
      <p className="mb-2 text-xs text-slate-500" data-testid="search-count">{rows.length} result{rows.length === 1 ? '' : 's'}{q.data?.cached ? ' (cached)' : ''}</p>
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm" data-testid="search-results">
          <thead className="border-b border-slate-200 text-xs text-slate-500 dark:border-slate-800">
            <tr>
              <th scope="col" className="px-3 py-2 text-left">Title</th>
              <th scope="col" className="px-2 py-2 text-left">Category</th>
              <th scope="col" className="hidden px-2 py-2 text-left md:table-cell">Indexer</th>
              <SortHeader k="size" label="Size" sort={sort} onSort={(k) => setSort(nextSort(sort, k))} />
              <SortHeader k="seeders" label="Seeders" sort={sort} onSort={(k) => setSort(nextSort(sort, k))} />
              <th scope="col" className="hidden px-2 py-2 text-right md:table-cell">Leechers</th>
              <SortHeader k="date" label="Published" sort={sort} onSort={(k) => setSort(nextSort(sort, k))} />
              <th scope="col" className="px-3 py-2"><span className="sr-only">Add</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map((r) => (
              <tr key={r.token} data-testid="search-row" data-category={r.category}>
                <td className="max-w-md break-words px-3 py-2 font-medium" data-testid="search-title">{r.title}</td>
                <td className="px-2 py-2 text-slate-600 dark:text-slate-300">{labels[r.category] ?? r.category}</td>
                <td className="hidden px-2 py-2 text-slate-600 md:table-cell dark:text-slate-300">{r.indexer.name ?? r.indexer.id ?? '-'}</td>
                <td className="whitespace-nowrap px-2 py-2 text-right">{formatBytes(r.size)}</td>
                <td className="px-2 py-2 text-right text-emerald-700 dark:text-emerald-400" data-testid="search-seeders">{r.seeders}</td>
                <td className="hidden px-2 py-2 text-right md:table-cell">{r.leechers}</td>
                <td className="whitespace-nowrap px-2 py-2 text-right text-slate-500">{r.publishedAt ? formatAge(r.publishedAt) : '-'}</td>
                <td className="px-3 py-2 text-right">
                  <Button size="sm" variant="primary" data-testid="search-add" aria-label={`Add ${r.title}`} onClick={() => setAdding(r)}>Add</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {adding && <AddDialog result={adding} onClose={() => setAdding(null)} />}
    </>
  );
}

export default function Search() {
  const meta = useQuery({ queryKey: ['search-meta'], queryFn: endpoints.searchMeta, retry: false, staleTime: 60_000 });
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('all');
  const [indexer, setIndexer] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<Submitted | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p = queryProblem(q);
    setProblem(p);
    if (!p) setSubmitted({ q: q.trim(), cat, indexer });
  };
  if (meta.isLoading) return <Spinner label="Loading search" />;
  if (meta.error) {
    const off = meta.error instanceof ApiError && meta.error.code === 'search_disabled';
    return (
      <>
        <PageHeader title="Search" />
        {off ? <Empty>Torrent search is not enabled on this server.</Empty> : <ErrorNote error={meta.error} />}
      </>
    );
  }
  const m = meta.data!;
  return (
    <>
      <PageHeader title="Search">
        <Link to="/" className="text-sm font-medium text-brand-600 hover:underline">Downloads</Link>
      </PageHeader>
      <form onSubmit={submit} className="card mb-4 flex flex-wrap items-end gap-3" role="search" aria-label="Search torrents" data-testid="search-form">
        <div className="min-w-[14rem] flex-1">
          <Field label="Search for">
            {(id) => <input id={id} data-testid="search-input" className="input" type="search" maxLength={200} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title, keywords..." autoFocus />}
          </Field>
        </div>
        <div className="w-40">
          <Field label="Category">
            {(id) => (
              <select id={id} data-testid="search-category" className="input" value={cat} onChange={(e) => setCat(e.target.value)}>
                <option value="all">All</option>
                {m.categories.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            )}
          </Field>
        </div>
        {m.indexersOk && m.indexers.length > 1 && (
          <div className="w-44">
            <Field label="Indexer">
              {(id) => (
                <select id={id} data-testid="search-indexer" className="input" value={indexer} onChange={(e) => setIndexer(e.target.value)}>
                  <option value="">All indexers</option>
                  {m.indexers.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                </select>
              )}
            </Field>
          </div>
        )}
        <Button type="submit" variant="primary" data-testid="search-submit">Search</Button>
      </form>
      {problem && <div className="mb-3"><ErrorNote error={new Error(problem)} /></div>}
      {m.indexersOk && m.indexers.length === 0 && (
        <p className="mb-3 text-sm text-amber-700 dark:text-amber-400" data-testid="search-no-indexers">No indexers are configured yet; ask an admin to add some.</p>
      )}
      {submitted ? <Results s={submitted} meta={m} /> : <Empty>Search the indexers your admin has configured, then add a result as a download.</Empty>}
    </>
  );
}
