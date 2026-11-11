import type { JobDto } from '../lib/api';
import { Badge } from './ui';

const TONE: Record<JobDto['state'], 'gray' | 'blue' | 'amber' | 'green' | 'red'> = {
  queued: 'gray', downloading: 'blue', uploading: 'amber', completed: 'green', failed: 'red', cancelled: 'gray',
};
export const StateBadge = ({ state }: { state: JobDto['state'] }) => <Badge tone={TONE[state]}>{state}</Badge>;
