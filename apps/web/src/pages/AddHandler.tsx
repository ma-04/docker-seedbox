import { Navigate, useLocation } from 'react-router-dom';
import { parseIncoming, setPendingIncoming } from '../lib/magnet';

/**
 * Target of the browser's magnet: protocol handler (`/add?magnet=<urlencoded>`). It only validates and hands the
 * value to the Downloads page, which pre-fills the form. Nothing is submitted: a web page must not be able to
 * start downloads by linking here. The redirect replaces the history entry, so the magnet leaves the address bar
 * and a reload does not pre-fill again.
 */
export default function AddHandler() {
  const { search } = useLocation();
  setPendingIncoming(parseIncoming(search));
  return <Navigate to="/" replace />;
}
