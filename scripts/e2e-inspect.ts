import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';

const usage = 'Usage: pnpm e2e:inspect <log-directory> [--event <substring>] [--full]';
const { values, positionals } = parseArgs({
  options: { event: { type: 'string' }, full: { type: 'boolean' } },
  allowPositionals: true,
  strict: true,
});
if (positionals.length !== 1 || !positionals[0] || values.event === '') {
  throw new Error(usage);
}

const TraceEvent = z.object({
  sequence: z.number().finite(),
  time: z.string(),
  elapsedMs: z.number().finite(),
  event: z.string(),
  data: z.unknown(),
}).refine(value => Object.hasOwn(value, 'data'), 'Missing data field');

function parseEvent(line: string, location: string): z.infer<typeof TraceEvent> {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (cause) {
    throw new Error(`Cannot parse trace at ${location}`, { cause });
  }
  try {
    return TraceEvent.parse(value);
  } catch (cause) {
    throw new Error(`Invalid trace record at ${location}`, { cause });
  }
}

function hasDiagnostics(value: unknown): boolean {
  if (typeof value === 'string') return /error|exception|failed|\bat .+\(.+:\d+/i.test(value);
  if (Array.isArray(value)) return value.some(hasDiagnostics);
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) =>
    /error|exception|stack|cause|message/i.test(key) || hasDiagnostics(child));
}

function summarize(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return JSON.stringify(value);
  const metadata: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === null || typeof child !== 'object') metadata[key] = child;
    else if (Array.isArray(child)) metadata[key] = `[${child.length} items]`;
    else {
      const nested: Record<string, unknown> = {};
      for (const name of ['id', 'type', 'method', 'path', 'status', 'model', 'sessionId', 'chatId', 'threadId']) {
        if (Object.hasOwn(child, name)) nested[name] = (child as Record<string, unknown>)[name];
      }
      if (Object.keys(nested).length) metadata[key] = nested;
    }
  }
  const text = JSON.stringify(metadata);
  return text.length <= 240 ? text : `${text.slice(0, 240)}… [use --full]`;
}

async function findArtifacts(directory: string, insideHistory = false): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const paths: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const history = insideHistory || /history/i.test(entry.name);
    if (entry.isDirectory()) {
      paths.push(...await findArtifacts(path, history));
    } else if (entry.isFile() && (history || /terminal/i.test(entry.name))) {
      paths.push(path);
    }
  }
  return paths;
}

const directory = resolve(positionals[0]);
const tracePath = join(directory, 'events.jsonl');
const source = await readFile(tracePath, 'utf8');
const lines = source.split('\n');
if (lines.at(-1) === '') lines.pop();
const events = lines.map((line, index) => parseEvent(line, `${tracePath}:${index + 1}`));
const artifacts = await findArtifacts(directory);
console.log(`Artifacts: ${directory}`);
console.log(`Trace: ${tracePath}`);
console.log('Terminal/history artifacts (paths only):');
for (const path of artifacts) console.log(`  ${relative(directory, path)}`);
if (!artifacts.length) console.log('  (none found)');
console.log('Timeline:');
for (const entry of events) {
  if (values.event !== undefined && !entry.event.includes(values.event)) continue;
  console.log(`#${entry.sequence} +${entry.elapsedMs}ms ${entry.event}`);
  if (values.full || /error|fail|exception/i.test(entry.event) || hasDiagnostics(entry.data)) {
    console.log(JSON.stringify(entry.data, null, 2));
  } else {
    console.log(`  ${summarize(entry.data)}`);
  }
}
