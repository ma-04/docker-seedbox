import { useState } from 'react';
import { isSupported, readState, registerHandler, shouldShowBanner, writeState, type HandlerState } from '../lib/magnetHandler';
import { Button, errMsg } from './ui';

const store = (): Storage | null => { try { return window.localStorage; } catch { return null; } };

/** "Open magnet links with this app": a dismissible banner the first time, a permanent small row afterwards. */
export function BrowserIntegration() {
  const supported = isSupported(navigator, window.isSecureContext);
  const [state, setState] = useState<HandlerState | null>(() => readState(store()));
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);

  const remember = (s: HandlerState) => { writeState(store(), s); setState(s); };
  const register = () => {
    setError(null);
    try {
      registerHandler(navigator, window.location.origin);
      setAsked(true);
      remember('registered');
    } catch (e) { setError(`Could not register: ${errMsg(e)}`); }
  };

  if (!supported) {
    return <p data-testid="magnet-handler-unsupported" className="mb-4 text-xs text-slate-500">Your browser cannot open magnet links with this app (no protocol handler support). Paste links into the form above.</p>;
  }

  const banner = shouldShowBanner(state, supported);
  return (
    <div className="mb-4">
      {banner ? (
        <div role="region" aria-label="Browser integration" data-testid="magnet-handler-banner" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-900">
          <span>Open magnet links with this app? Your browser will ask you to confirm.</span>
          <span className="flex gap-2">
            <Button size="sm" variant="primary" data-testid="magnet-handler-register" onClick={register}>Open magnet links with this app</Button>
            <Button size="sm" variant="ghost" data-testid="magnet-handler-dismiss" onClick={() => remember('dismissed')}>Not now</Button>
          </span>
        </div>
      ) : (
        <p data-testid="magnet-handler-row" className="text-xs text-slate-500">
          Browser integration:{' '}
          <button type="button" data-testid="magnet-handler-register" onClick={register} className="font-medium text-brand-600 hover:underline">
            {state === 'registered' ? 'Register again' : 'Open magnet links with this app'}
          </button>
          {' '}(your browser will ask you to confirm)
        </p>
      )}
      {asked && <p role="status" className="mt-1 text-xs text-slate-500">Registration requested. Confirm it in your browser's prompt; you can remove it in the browser's settings.</p>}
      {error && <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
