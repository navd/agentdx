import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

// "Models & Tokens" merged into the Tokenomics page (Models tab). Kept as a
// redirect so existing links/bookmarks keep working.
export default async function ModelsRedirect({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const { period } = await searchParams;
  redirect(`/tokenomics?tab=models${period ? `&period=${period}` : ''}`);
}
