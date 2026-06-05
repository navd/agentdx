'use client';

import { useState } from 'react';

function getRedactionRules(): [RegExp, string][] {
  return [
    [/AKIA[0-9A-Z]{12,}/g, '[REDACTED:aws-key]'],
    [/sk-[a-zA-Z0-9_-]{8,}/g, '[REDACTED:api-key]'],
    [/(postgres|mysql|mongodb):\/\/[^\s"')]+/g, '[REDACTED:connection-string]'],
    [/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED:email]'],
    [/password|passwd|s3cr3t/gi, '[REDACTED:secret]'],
  ];
}

const DEFAULT_TEXT = `export OPENAI_API_KEY=sk-local-test-value\nemail dev@example.com about retry fix`;

export function RedactionTester() {
  const [input, setInput] = useState(DEFAULT_TEXT);
  const [result, setResult] = useState<{ text: string; count: number } | null>(null);

  function runRedaction() {
    let text = input;
    let count = 0;
    for (const [pattern, replacement] of getRedactionRules()) {
      const matches = text.match(pattern);
      if (matches) count += matches.length;
      text = text.replace(pattern, replacement);
    }
    setResult({ text, count });
  }

  function handleClear() {
    setInput('');
    setResult(null);
  }

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3 className="card-title">Redaction tester</h3>
          <p className="card-sub">Paste text to preview how sensitive data is redacted before storage</p>
        </div>
      </div>
      <div className="card-pad">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={5}
          style={{
            width: '100%',
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: 13,
            padding: '10px 12px',
            borderRadius: 6,
            border: '1px solid var(--border)',
            background: 'var(--bg-inset, var(--bg))',
            color: 'var(--text)',
            resize: 'vertical',
          }}
        />
        <div className="row gap-8" style={{ marginTop: 12 }}>
          <button className="btn btn-sm btn-primary" onClick={runRedaction}>
            Test redaction
          </button>
          <button className="btn btn-sm" onClick={handleClear}>
            Clear
          </button>
        </div>

        {result && (
          <div style={{ marginTop: 16 }}>
            <div style={{ marginBottom: 8 }}>
              <span className="badge badge-warn">{result.count} redacted</span>
            </div>
            <div className="term">
              <pre className="term-body" style={{ padding: '12px 14px', fontSize: 12, whiteSpace: 'pre-wrap', margin: 0 }}>
                {result.text}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
