// Estimated API cost for recorded token usage — "what this would have cost at
// public pay-as-you-go API list prices". Pure module (no DB import), safe in
// client components.
//
// List prices verified June 2026 against:
//   Anthropic  platform.claude.com/docs/en/docs/about-claude/pricing
//   OpenAI     developers.openai.com/api/docs/pricing
//   Google     ai.google.dev/gemini-api/docs/pricing
//   xAI        x.ai/api · DeepSeek api-docs.deepseek.com
//
// Caveats baked into the estimate:
// - Standard tier only. No batch/flex discounts, no fast-mode premium, no
//   regional multipliers — agent traffic is interactive standard-tier.
// - Anthropic cache writes are billed at the 5-minute rate (1.25x input);
//   that's what Claude Code uses. OpenAI/Google don't charge cache writes
//   per-token (Google bills cache storage per hour — not modelable from
//   token counts, so omitted).
// - Local models (Ollama-style `name:tag`, qwen/llama/gemma/phi families)
//   cost $0 — they never hit a paid API.
// - Unknown models return null: surfaced as "unpriced", never guessed.

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelPricing {
  /** Tested against the normalized model name (lowercase, spaces/underscores → '-') */
  match: RegExp;
  provider: string;
  /** USD per million tokens */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  local?: boolean;
}

// Ordered: first match wins, so more specific patterns (mini/nano/codex/pro)
// must precede their base model.
const PRICING: ModelPricing[] = [
  // ---- Local (free) — `name:tag` is an Ollama tag; bare family names too ----
  { match: /:|^(qwen|llama|codellama|gemma|phi-|phi[0-9]|mistral|mixtral|starcoder|devstral)/, provider: 'Local', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, local: true },

  // ---- Anthropic (cacheWrite = 5m rate = 1.25x input; cacheRead = 0.1x) ----
  { match: /claude-(fable|mythos)-5/, provider: 'Anthropic', input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  { match: /claude-opus-4-[5-9]/, provider: 'Anthropic', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { match: /claude-opus-4/, provider: 'Anthropic', input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  { match: /claude-(3-7-)?sonnet|claude-3-5-sonnet/, provider: 'Anthropic', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { match: /claude-3-5-haiku|claude-haiku-3/, provider: 'Anthropic', input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  { match: /claude-haiku/, provider: 'Anthropic', input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  { match: /claude-3-opus/, provider: 'Anthropic', input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },

  // ---- OpenAI (cacheRead = cached-input rate; cache writes not billed) ----
  { match: /gpt-5\.[45]-pro|gpt-5-pro/, provider: 'OpenAI', input: 30, output: 180, cacheRead: 30, cacheWrite: 0 },
  { match: /gpt-5\.5/, provider: 'OpenAI', input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  { match: /gpt-5\.4-mini/, provider: 'OpenAI', input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
  { match: /gpt-5\.4-nano/, provider: 'OpenAI', input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0 },
  { match: /gpt-5\.4/, provider: 'OpenAI', input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  { match: /gpt-5\.[23]-codex/, provider: 'OpenAI', input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  { match: /gpt-5(\.1)?-codex-mini|codex-mini/, provider: 'OpenAI', input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
  { match: /gpt-5\.1|gpt-5-codex/, provider: 'OpenAI', input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  { match: /gpt-5-mini/, provider: 'OpenAI', input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
  { match: /gpt-5-nano/, provider: 'OpenAI', input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0 },
  { match: /gpt-5/, provider: 'OpenAI', input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  { match: /gpt-4\.1-nano/, provider: 'OpenAI', input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0 },
  { match: /gpt-4\.1-mini/, provider: 'OpenAI', input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0 },
  { match: /gpt-4\.1/, provider: 'OpenAI', input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
  { match: /gpt-4o-mini/, provider: 'OpenAI', input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 },
  { match: /gpt-4o/, provider: 'OpenAI', input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
  { match: /\bo3-mini|\bo4-mini/, provider: 'OpenAI', input: 1.1, output: 4.4, cacheRead: 0.275, cacheWrite: 0 },
  { match: /\bo3\b/, provider: 'OpenAI', input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },

  // ---- Google (cacheRead = context-cache rate; hourly storage omitted) ----
  { match: /gemini-3\.5-flash/, provider: 'Google', input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 },
  { match: /gemini-3(\.1)?-pro/, provider: 'Google', input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  { match: /gemini-3\.1-flash-lite/, provider: 'Google', input: 0.25, output: 1.5, cacheRead: 0.025, cacheWrite: 0 },
  { match: /gemini-3-flash/, provider: 'Google', input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 },
  { match: /gemini-2\.5-pro/, provider: 'Google', input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  { match: /gemini-2\.5-flash-lite/, provider: 'Google', input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0 },
  { match: /gemini-2\.5-flash/, provider: 'Google', input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },

  // ---- xAI ----
  { match: /grok-code-fast/, provider: 'xAI', input: 0.2, output: 1.5, cacheRead: 0.02, cacheWrite: 0 },
  { match: /grok-4\.3/, provider: 'xAI', input: 1.25, output: 2.5, cacheRead: 0.125, cacheWrite: 0 },
  { match: /grok-4(\.1)?-fast/, provider: 'xAI', input: 0.2, output: 0.5, cacheRead: 0.05, cacheWrite: 0 },
  { match: /grok-4/, provider: 'xAI', input: 3, output: 15, cacheRead: 0.75, cacheWrite: 0 },
  { match: /grok-build/, provider: 'xAI', input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },

  // ---- DeepSeek (API-hosted; local distills hit the Ollama rule above) ----
  { match: /deepseek/, provider: 'DeepSeek', input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0 },
];

function normalize(model: string): string {
  return model.toLowerCase().trim().replace(/[\s_]+/g, '-');
}

export function getModelPricing(model: string): ModelPricing | null {
  if (!model || model === '<synthetic>') return null;
  const m = normalize(model);
  for (const p of PRICING) {
    if (p.match.test(m)) return p;
  }
  return null;
}

/**
 * Estimated USD for this usage at API list prices.
 * Returns null when the model is unknown — callers must show "unpriced",
 * not zero, so missing pricing never reads as "free".
 */
export function estimateCostUsd(model: string, usage: TokenUsage): number | null {
  const p = getModelPricing(model);
  if (!p) return null;
  const M = 1_000_000;
  return (
    (usage.input / M) * p.input +
    (usage.output / M) * p.output +
    (usage.cacheRead / M) * p.cacheRead +
    (usage.cacheWrite / M) * p.cacheWrite
  );
}

export function fmtUsd(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.01) return '<$0.01';
  if (n < 100) return '$' + n.toFixed(2);
  return '$' + Math.round(n).toLocaleString('en-US');
}
