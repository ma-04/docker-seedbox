import { DestinationsManager } from '../components/DestinationsManager';
import { PageHeader } from '../components/ui';

export default function Storage() {
  return (
    <>
      <PageHeader title="Storage" />
      <p className="mb-4 text-sm text-slate-600 dark:text-slate-400">
        Destinations are where finished downloads are delivered. Shared destinations are managed by an administrator; you can add your own S3-compatible storage.
      </p>
      <DestinationsManager admin={false} />
    </>
  );
}
