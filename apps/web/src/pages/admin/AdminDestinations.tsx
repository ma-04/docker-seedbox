import { DestinationsManager } from '../../components/DestinationsManager';
import { PageHeader } from '../../components/ui';

export default function AdminDestinations() {
  return (
    <>
      <PageHeader title="Shared destinations" />
      <DestinationsManager admin />
    </>
  );
}
