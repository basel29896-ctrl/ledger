/*
 * The detail route is a server component purely so it can declare which entry
 * ids exist at build time. The screen itself is the client component below.
 *
 * A static export can only serve pages it built, so the demo adds its reserved
 * pool of ids to the captured ones: an entry posted while browsing the demo has
 * a page to land on. A server-rendered deployment ignores all of this and
 * renders any id on demand.
 */
import { EntryDetail } from './entry-detail';

export function generateStaticParams(): { id: string }[] {
  if (process.env.NEXT_PUBLIC_DEMO !== '1') return [];
  /* eslint-disable @typescript-eslint/no-require-imports */
  const fixture = require('../../../demo/fixture.json') as { entries: { id: string }[] };
  const reserved = Array.from(
    { length: 20 },
    (_, i) => `demo-entry-${String(i + 1).padStart(2, '0')}`,
  );
  return [...fixture.entries.map((e) => e.id), ...reserved].map((id) => ({ id }));
}

export default function JournalEntryPage() {
  return <EntryDetail />;
}
