import { ContextTracker, ExternalTokenizer } from '@lezer/lr';

export interface SourceCommandToken {
  term: number;
  end: number;
}

export function commandTokenContext(tokens: ReadonlyMap<number, SourceCommandToken>) {
  return new ContextTracker({ start: tokens, strict: false });
}

export const commandContext = commandTokenContext(new Map());

export const commandTokenizer = new ExternalTokenizer((input, stack) => {
  const context: ReadonlyMap<number, SourceCommandToken> = stack.context;
  const token = context.get(input.pos);
  if (token) input.acceptTokenTo(token.term, token.end);
});
