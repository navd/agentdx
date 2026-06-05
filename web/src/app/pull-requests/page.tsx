import { redirect } from 'next/navigation';

// Pull Requests merged into Repositories (/repositories shows both).
export default function PullRequestsPage() {
  redirect('/repositories');
}
