import Link from 'next/link';
import {
  SquareTerminal, BrainCircuit, FileDiff, ShieldCheck,
  FolderOpen, Database, Activity, AlertCircle, Search,
} from 'lucide-react';

const ICONS: Record<string, React.ReactNode> = {
  'square-terminal': <SquareTerminal size={36} />,
  'brain-circuit': <BrainCircuit size={36} />,
  'file-diff': <FileDiff size={36} />,
  'shield-check': <ShieldCheck size={36} />,
  'folder-open': <FolderOpen size={36} />,
  'database': <Database size={36} />,
  'activity': <Activity size={36} />,
  'alert-circle': <AlertCircle size={36} />,
  'search': <Search size={36} />,
};

interface EmptyStateProps {
  icon: string;
  title: string;
  description: string;
  action?: { label: string; href: string };
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '64px 24px',
      textAlign: 'center',
      gap: 12,
      minHeight: 300,
    }}>
      <div style={{ color: 'var(--text-muted)', opacity: 0.5 }}>
        {ICONS[icon] || <Database size={36} />}
      </div>
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{title}</h2>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)', maxWidth: 400 }}>
        {description}
      </p>
      {action && (
        <Link href={action.href} className="btn btn-primary" style={{ marginTop: 8 }}>
          {action.label}
        </Link>
      )}
    </div>
  );
}
