import { parser as generatedParser } from './telegram-command-parser.js';
import { isMentionableSkillName } from './skill-commands.js';

const parser = generatedParser.configure({ strict: true });

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
  kind: string;
  image: string;
  start: number;
  end: number;
  action?: string;
  skill?: string;
  wrongBot?: boolean;
}

const commandKinds: Readonly<Record<string, string>> = {
  new: 'n', p: 'p', worktree: 't', model_preset: 'm', skills: 's', attach: 'a',
  settings: 'b', setup: 'c', list_admins: 'd', detach: 'e', session: 'f', status: 'g',
  usage: 'h', stop: 'i', kill: 'j', terminate: 'k', help: 'l', start: 'o', cli: 'q',
};

// Every non-whitespace span is consumed, including malformed and unknown commands.
// Token positions retain the untouched source for literal prompt extraction.
export function tokenizeTelegramCommand(
  text: string,
  username: string,
  aliases: ReadonlyMap<string, { name: string }> = new Map(),
): TelegramCommandToken[] {
  const tokens: TelegramCommandToken[] = [];
  for (const match of text.matchAll(/\S+/gu)) {
    const image = match[0];
    const token: TelegramCommandToken = { kind: 'w', image, start: match.index, end: match.index + image.length };
    if (image.startsWith('/')) {
      token.kind = 'u';
      const canonical = /^\/skill:([^\s]+)$/.exec(image);
      const command = /^\/([a-z0-9_]+)(?:@([a-z0-9_]+))?$/i.exec(image);
      if (canonical && isMentionableSkillName(canonical[1]!)) {
        token.kind = 'v';
        token.skill = canonical[1]!;
      } else if (command) {
        token.action = command[1]!.toLowerCase();
        token.wrongBot = !!command[2] && command[2].toLowerCase() !== username.replace(/^@/, '').toLowerCase();
        const skill = aliases.get(token.action);
        token.kind = token.wrongBot ? 'u' : commandKinds[token.action] ?? (skill ? 'v' : 'u');
        if (skill) token.skill = skill.name;
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
  if (!root || root.start !== 0 || !root.image.startsWith('/') || root.kind === 'u') return { kind: 'ignore' };
  try {
    const tree = parser.parse(tokens.map(token => token.kind).join(''));
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
    const addSkill = (index: number) => {
      const name = tokens[index]!.skill!;
      if (!skills.has(name)) { extensions.push({ kind: 'skill', name }); skills.add(name); }
    };
    for (let node = request.firstChild; node; node = node.nextSibling) {
      if (node.name === 'Tail') {
        prompt = text.slice(tokens[node.from]!.start, tokens.at(-1)!.end);
      } else if (node.name === 'Skill') {
        addSkill(node.from);
      } else if (node.name === 'Extension') {
        const extension = node.firstChild!;
        if (extension.name === 'Skill') addSkill(extension.from);
        else if (extension.name === 'Preset') {
          if (preset) throw new SyntaxError('Repeated model preset extension');
          if (!/^[A-Za-z][\w-]*$/.test(tokens[extension.from + 1]!.image)) throw new SyntaxError('Invalid model preset name');
          preset = true;
          extensions.push({ kind: 'model-preset', name: tokens[extension.from + 1]!.image });
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
