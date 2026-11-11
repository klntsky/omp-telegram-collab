export function combineTelegramErrors(...errors: unknown[]): AggregateError {
  return new AggregateError(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join('\n'), { cause: errors[0] });
}
