import { parser as generatedParser } from './telegram-command-parser.js';
import * as terms from './telegram-command-parser.terms.js';
import { commandTokenContext } from './telegram-command-tokens.js';
import { isMentionableSkillName } from './skill-commands.js';

class TelegramCommandValidationError extends Error {}

export type PromptExtension =
  | { kind: 'model-preset'; name?: string }
  | { kind: 'worktree' }
  | { kind: 'skill'; name: string };

export type TelegramCommandResult =
  | { kind: 'ignore' }
  | { kind: 'command'; action: string; argument: string }
  | { kind: 'prompt'; action: 'new' | 'p'; text: string; extensions: PromptExtension[] }
  | { kind: 'selection'; name: string }
  | { kind: 'invalid'; error: Error };

export interface TelegramCommandToken {
  kind: 'text' | 'command' | 'skill' | 'unknown';
  term: number;
  image: string;
  start: number;
  end: number;
  action?: string;
  skill?: string;
}

export function tokenizeTelegramCommand(
  text: string,
  username: string,
  aliases: ReadonlyMap<string, { name: string }> = new Map(),
): TelegramCommandToken[] {
  const tokens: TelegramCommandToken[] = [];
  for (const match of text.matchAll(/\S+/gu)) {
    const image = match[0];
    const token: TelegramCommandToken = { kind: 'text', term: terms.TextToken, image, start: match.index, end: match.index + image.length };
    if (image.startsWith('/')) {
      token.kind = 'unknown';
      token.term = terms.UnknownToken;
      const canonical = /^\/skill:([^\s]+)$/.exec(image);
      const command = /^\/([a-z0-9_]+)(?:@([a-z0-9_]+))?$/i.exec(image);
      if (canonical && isMentionableSkillName(canonical[1]!)) {
        token.kind = 'skill';
        token.term = terms.SkillToken;
        token.skill = canonical[1]!;
      } else if (command) {
        token.action = command[1]!.toLowerCase();
        const wrongBot = !!command[2] && command[2].toLowerCase() !== username.replace(/^@/, '').toLowerCase();
        if (!wrongBot) {
          const terminal = `command_${token.action}`;
          if (Object.hasOwn(terms, terminal)) {
            token.kind = 'command';
            token.term = terms[terminal as keyof typeof terms];
          } else {
            const skill = aliases.get(token.action);
            if (skill) {
              token.kind = 'skill';
              token.term = terms.SkillToken;
              token.skill = skill.name;
            }
          }
        }
      }
    }
    tokens.push(token);
  }
  return tokens;
}

export function parseTelegramCommand(
  text: string,
  username: string,
  aliases: ReadonlyMap<string, { name: string }> = new Map(),
): TelegramCommandResult {
  const tokens = tokenizeTelegramCommand(text, username, aliases);
  const root = tokens[0];
  if (!root || root.start !== 0 || !root.image.startsWith('/') || root.kind === 'unknown') return { kind: 'ignore' };
  try {
    const byStart = new Map(tokens.map(token => [token.start, token]));
    const parser = generatedParser.configure({ strict: true, contextTracker: commandTokenContext(byStart) });
    const tree = (() => {
      try { return parser.parse(text); }
      catch (error) {
        // Lezer strict parsing signals invalid input with SyntaxError, not arbitrary failures.
        // https://github.com/lezer-parser/lr/blob/main/src/parse.ts — Parse.advance.
        if (!(error instanceof SyntaxError)) throw error;
        throw new TelegramCommandValidationError(`Telegram command /${root.action ?? 'skill'} parsing failed: ${error.message}`, {cause: error});
      }
    })();
    const request = tree.topNode.firstChild!;
    if (request.name !== 'Prompt' && request.name !== 'SkillPrompt') {
      const argument = tokens.length > 1 ? text.slice(tokens[1]!.start, tokens.at(-1)!.end) : '';
      switch (request.name) {
        case 'Inspection':
        case 'Configuration':
        case 'Lifecycle':
        case 'Guidance':
          if (tokens.length > 1) throw new TelegramCommandValidationError(`Usage: /${root.action}`);
          break;
        case 'Start':
        case 'OptionalArgument':
        case 'Skills':
          if (tokens.length > 2 || (tokens[1] && tokens[1].kind !== 'text'))
            throw new TelegramCommandValidationError(`Usage: /${root.action} ${request.name === 'Skills' ? '[clear]' : request.name === 'Start' ? '[payload]' : root.action === 'worktree' ? '[branch]' : '[name]'}`);
          break;
        case 'Attach':
          if (!tokens[1] || tokens[1].kind !== 'text') throw new TelegramCommandValidationError('Usage: /attach <instanceId> [name]');
          break;
      }
      if (request.name === 'Skills' && argument && argument !== 'clear') throw new TelegramCommandValidationError('Telegram /skills validation failed: Expected clear or no argument');
      if (root.action === 'modelpreset' && argument && !/^[A-Za-z][\w-]*$/.test(argument)) throw new TelegramCommandValidationError('Telegram /modelpreset validation failed: Invalid model preset name');
      return { kind: 'command', action: root.action!, argument };
    }
    const extensions: PromptExtension[] = [];
    const skills = new Set<string>();
    let preset = false;
    let worktree = false;
    let prompt = '';
    const addSkill = (name: string) => {
      if (!skills.has(name)) { extensions.push({ kind: 'skill', name }); skills.add(name); }
    };
    if (root.kind === 'skill') addSkill(root.skill!);
    for (let index = 1; index < tokens.length; index++) {
      const token = tokens[index]!;
      if (token.kind === 'skill') {
        addSkill(token.skill!);
      } else if (token.kind === 'command' && token.action === 'worktree' && !worktree) {
        worktree = true;
        extensions.push({ kind: 'worktree' });
      } else if (token.kind === 'command' && token.action === 'modelpreset' && !preset
        && (!tokens[index + 1] || tokens[index + 1]!.kind === 'command' || tokens[index + 1]!.kind === 'skill'
          || (tokens[index + 1]!.kind === 'text' && /^[A-Za-z][\w-]*$/.test(tokens[index + 1]!.image)))) {
        preset = true;
        extensions.push(tokens[index + 1]?.kind === 'text'
          ? { kind: 'model-preset', name: tokens[++index]!.image }
          : { kind: 'model-preset' });
      } else {
        prompt = text.slice(token.start, tokens.at(-1)!.end);
        break;
      }
    }
    if (request.name === 'SkillPrompt' && tokens.length === 1) return root.action
      ? { kind: 'command', action: root.action, argument: '' }
      : { kind: 'selection', name: root.skill! };
    return { kind: 'prompt', action: root.action === 'new' ? 'new' : 'p', text: prompt, extensions };
  } catch (error) {
    if (!(error instanceof TelegramCommandValidationError)) throw error;
    return { kind: 'invalid', error };
  }
}
