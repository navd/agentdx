import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

// FinOps merged into the Tokenomics page (Cost tab). Kept as a redirect so
// existing links/bookmarks keep working.
export default async function FinopsRedirect({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const { period } = await searchParams;
  redirect(`/tokenomics?tab=cost${period ? `&period=${period}` : ''}`);
}
