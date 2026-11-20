export function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

export function codeHtml(text: string): string {
  return `<code>${escapeHtml(text)}</code>`;
}

export function preHtml(text: string): string {
  return `<pre>${escapeHtml(text)}</pre>`;
}
