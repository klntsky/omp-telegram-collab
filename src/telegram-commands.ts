import { parser as generatedParser } from './telegram-command-parser.js';
import * as terms from './telegram-command-parser.terms.js';
import { commandTokenContext } from './telegram-command-tokens.js';
import { isMentionableSkillName } from './skill-commands.js';

export type PromptExtension =
  | { kind: 'model-preset'; name: string }
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
    const tree = parser.parse(text);
    const request = tree.topNode.firstChild!;
    if (request.name !== 'Prompt' && request.name !== 'SkillPrompt') {
      const argument = tokens.length > 1 ? text.slice(tokens[1]!.start, tokens.at(-1)!.end) : '';
      if (request.name === 'Skills' && argument && argument !== 'clear') throw new SyntaxError('Expected clear or no argument');
      if (root.action === 'model_preset' && argument && !/^[A-Za-z][\w-]*$/.test(argument)) throw new SyntaxError('Invalid model preset name');
      return { kind: 'command', action: root.action!, argument };
    }
    const extensions: PromptExtension[] = [];
    const skills = new Set<string>();
    let preset = false;
    let worktree = false;
    let prompt = '';
    const addSkill = (position: number) => {
      const name = byStart.get(position)!.skill!;
      if (!skills.has(name)) { extensions.push({ kind: 'skill', name }); skills.add(name); }
    };
    for (let node = request.firstChild; node; node = node.nextSibling) {
      if (node.name === 'Tail') {
        prompt = text.slice(node.from, tokens.at(-1)!.end);
      } else if (node.name === 'Skill') {
        addSkill(node.from);
      } else if (node.name === 'Extension') {
        const extension = node.firstChild!;
        if (extension.name === 'Skill') addSkill(extension.from);
        else if (extension.name === 'Preset') {
          if (preset) throw new SyntaxError('Repeated model preset extension');
          const name = byStart.get(extension.getChild('Word')!.from)!.image;
          if (!/^[A-Za-z][\w-]*$/.test(name)) throw new SyntaxError('Invalid model preset name');
          preset = true;
          extensions.push({ kind: 'model-preset', name });
        } else {
          if (worktree) throw new SyntaxError('Repeated worktree extension');
          worktree = true;
          extensions.push({ kind: 'worktree' });
        }
      }
    }
    if (request.name === 'SkillPrompt' && tokens.length === 1) return root.action
      ? { kind: 'command', action: root.action, argument: '' }
      : { kind: 'selection', name: root.skill! };
    return { kind: 'prompt', action: root.action === 'new' ? 'new' : 'p', text: prompt, extensions };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { kind: 'invalid', error };
  }
}
