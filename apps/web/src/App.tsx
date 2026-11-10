import { NavLink, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { Spinner, ErrorNote, cx } from './components/ui';
import { useMe } from './lib/hooks';
import AdminDestinations from './pages/admin/AdminDestinations';
import AdminJobs from './pages/admin/AdminJobs';
import AdminSettings from './pages/admin/AdminSettings';
import AdminUsers from './pages/admin/AdminUsers';
import AdminVpn from './pages/admin/AdminVpn';
import Downloads from './pages/Downloads';
import AddHandler from './pages/AddHandler';
import Storage from './pages/Storage';
import type { MeDto } from './lib/api';

const navCls = ({ isActive }: { isActive: boolean }) =>
  cx('block rounded-md px-3 py-2 text-sm font-medium', isActive ? 'bg-brand-600 text-white' : 'text-slate-700 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800');

function Layout({ me }: { me: MeDto }) {
  return (
    <div className="min-h-screen md:flex">
      <aside className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 md:w-56 md:shrink-0 md:border-b-0 md:border-r">
        <div className="flex items-center gap-2 px-4 py-3">
          <img src="/icon.svg" alt="" className="h-8 w-8" />
          <span className="text-base font-semibold">docker-seedbox</span>
        </div>
        <nav aria-label="Main" className="flex gap-1 overflow-x-auto px-2 pb-2 md:block md:space-y-1 md:pb-4">
          <NavLink to="/" end className={navCls}>Downloads</NavLink>
          <NavLink to="/storage" className={navCls}>Storage</NavLink>
          {me.isAdmin && (
            <>
              <p className="hidden px-3 pt-3 text-xs font-semibold uppercase tracking-wide text-slate-500 md:block">Admin</p>
              <NavLink to="/admin/destinations" className={navCls}>Destinations</NavLink>
              <NavLink to="/admin/vpn" className={navCls}>VPN</NavLink>
              <NavLink to="/admin/settings" className={navCls}>Settings</NavLink>
              <NavLink to="/admin/users" className={navCls}>Users</NavLink>
              <NavLink to="/admin/jobs" className={navCls}>All jobs</NavLink>
            </>
          )}
        </nav>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="flex items-center justify-end gap-3 border-b border-slate-200 bg-white px-4 py-2 text-sm dark:border-slate-800 dark:bg-slate-900">
          <span data-testid="current-user" className="text-slate-600 dark:text-slate-300">{me.user.displayName ?? me.user.username}</span>
          {me.isAdmin && <span className="rounded-full bg-brand-100 px-2 py-0.5 text-xs font-medium text-brand-700">admin</span>}
          {me.logoutUrl && <a href={me.logoutUrl} className="font-medium text-brand-600 hover:underline">Log out</a>}
        </header>
        <main className="mx-auto max-w-6xl p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export default function App() {
  const me = useMe();
  if (me.isLoading) return <Spinner label="Loading" />;
  if (me.error || !me.data) {
    // A 401 triggers a one-time page reload (see api.ts); anything else is shown.
    return <div className="p-6"><ErrorNote error={me.error ?? new Error('Could not load your account')} /></div>;
  }
  const isAdmin = me.data.isAdmin;
  return (
    <Routes>
      <Route element={<Layout me={me.data} />}>
        <Route index element={<Downloads />} />
        <Route path="add" element={<AddHandler />} />
        <Route path="storage" element={<Storage />} />
        <Route path="admin">
          <Route index element={<Navigate to={isAdmin ? 'destinations' : '/'} replace />} />
          <Route path="destinations" element={isAdmin ? <AdminDestinations /> : <Navigate to="/" replace />} />
          <Route path="vpn" element={isAdmin ? <AdminVpn /> : <Navigate to="/" replace />} />
          <Route path="settings" element={isAdmin ? <AdminSettings /> : <Navigate to="/" replace />} />
          <Route path="users" element={isAdmin ? <AdminUsers /> : <Navigate to="/" replace />} />
          <Route path="jobs" element={isAdmin ? <AdminJobs /> : <Navigate to="/" replace />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
