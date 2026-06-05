'use client';

/** Triggers the browser's print dialog (Save as PDF). No server, no upload. */
export function PrintButton({ label = 'Print / Save PDF' }: { label?: string }) {
  return (
    <button className="btn btn-sm btn-primary" onClick={() => window.print()}>
      {label}
    </button>
  );
}
