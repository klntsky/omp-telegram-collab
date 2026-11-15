import { stat } from 'node:fs/promises';
import { z } from 'zod';

export class GatewayInputError extends Error {}
export class StaticResourceMissingError extends Error {}
export class GatewayAccessError extends Error {}
export function parseGatewayInput<T>(operation: string, parse: () => T): T {
  try { return parse(); }
  catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof URIError) && !(error instanceof z.ZodError)) throw error;
    throw new GatewayInputError(`${operation}: ${error.message}`, {cause: error});
  }
}

export async function isStaticFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) throw error;
    throw new StaticResourceMissingError(`Read Mini App static resource ${path}: ${error.message}`, {cause: error});
  }
}
