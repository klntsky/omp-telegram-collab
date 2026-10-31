const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function formatUsage(result: unknown, now = new Date()): string {
  if (!record(result) || !Array.isArray(result.reports)) throw new Error('Invalid OMP usage response');
  const providers: Record<string, string> = {
    'openai-codex': 'OpenAI Codex', anthropic: 'Anthropic', cursor: 'Cursor', 'google-antigravity': 'Antigravity',
  };
  const labels: Record<string, string> = {
    'Claude 5 Hour': 'Claude 5h', 'Claude 7 Day': 'Claude 7d', 'Cursor Models': 'Models',
    'Other Models': 'Other', 'On-Demand Usage': 'On-demand', 'Claude & GPT (shared)': 'Claude/GPT', 'Gemini (Argon)': 'Gemini Argon',
  };
  const date = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const lines = [`${'Left'.padStart(21)}  Reset`, '─'.repeat(28)];
  for (const report of result.reports) {
    if (!record(report) || typeof report.provider !== 'string' || !Array.isArray(report.limits)) throw new Error('Invalid OMP usage report');
    if (lines.length > 2) lines.push('');
    lines.push(providers[report.provider] ?? report.provider);
    const rows = new Map<string, { label: string; left: string; reset: string; count: number; status?: string }>();
    for (const limit of report.limits) {
      if (!record(limit) || !record(limit.amount)) throw new Error('Invalid OMP usage limit');
      const amount = limit.amount;
      const window = record(limit.window) ? limit.window : {};
      const originalLabel = String(limit.label ?? window.label ?? 'Quota');
      const label = labels[originalLabel] ?? originalLabel;
      const left = !finite(amount.remaining) ? '?' : amount.unit === 'usd' ? `$${amount.remaining.toFixed(2)}`
        : `${Number(amount.remaining.toFixed(2))}${amount.unit === 'percent' ? '%' : typeof amount.unit === 'string' ? ` ${amount.unit}` : ''}`;
      const resetsAt = finite(window.resetsAt) ? new Date(window.resetsAt) : undefined;
      const reset = resetsAt && Number.isFinite(resetsAt.getTime())
        ? resetsAt.toISOString().slice(0, 10) === now.toISOString().slice(0, 10) ? 'Today' : date.format(resetsAt) : '—';
      const status = typeof limit.status === 'string' && limit.status !== 'ok' ? limit.status : undefined;
      const key = JSON.stringify([originalLabel, amount, window, status]);
      const previous = rows.get(key);
      if (previous) previous.count++;
      else rows.set(key, { label, left, reset, count: 1, status });
    }
    for (const row of rows.values()) {
      const label = row.label + (row.count > 1 ? ` ×${row.count}` : '');
      lines.push(`  ${label.padEnd(13)}${row.left.padStart(6)}  ${row.reset.padStart(5)}`);
      if (row.status) lines.push(`  ⚠ ${row.status}`);
    }
    if (!report.limits.length) lines.push('  No quota data available.');
    if (typeof report.error === 'string') lines.push(report.error);
  }
  return result.reports.length ? lines.join('\n') : 'No provider usage data available.';
}
