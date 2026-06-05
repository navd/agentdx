'use client';

import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallbackTitle?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="card" style={{
          padding: '32px 24px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 12,
          textAlign: 'center',
          border: '1px solid var(--neg, #ef4444)',
          borderRadius: 8,
        }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--neg, #ef4444)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <h4 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
            {this.props.fallbackTitle || 'Something went wrong'}
          </h4>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)', maxWidth: 400 }}>
            {this.state.error?.message || 'An unexpected error occurred while rendering this section.'}
          </p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="btn btn-sm"
            style={{ marginTop: 4 }}
          >
            Reload
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
