import { redirect } from 'next/navigation';

// Rules & Policy merged into Risk (/risk shows risk, quality, and policy).
export default function RulesPage() {
  redirect('/risk');
}
