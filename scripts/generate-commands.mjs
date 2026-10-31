import { readFile, writeFile } from 'node:fs/promises';
import { buildParserFile } from '@lezer/generator';

const grammar = await readFile(new URL('../src/telegram-commands.grammar', import.meta.url), 'utf8');
const generated = buildParserFile(grammar, {
  fileName: 'src/telegram-commands.grammar',
  typeScript: true,
  warn(message) { throw new Error(message); },
});
await writeFile(new URL('../src/telegram-command-parser.ts', import.meta.url), generated.parser);
await writeFile(new URL('../src/telegram-command-parser.terms.ts', import.meta.url), generated.terms);
