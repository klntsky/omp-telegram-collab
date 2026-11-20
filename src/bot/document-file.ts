import { randomUUID } from 'node:crypto';
import { constants, closeSync, fchmodSync, fstatSync, lstatSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { PromptPreparationRejectedError } from './types.js';

export class PermanentDocumentPreparationError extends PromptPreparationRejectedError {}

export function documentFileName(value: string): string {
  const name = basename(value.replaceAll('\\', '/'));
  if (!name || name === '.' || name === '..' || /[\x00-\x1f\x7f]/.test(name))
    throw new PermanentDocumentPreparationError('The document filename is unsafe.');
  return name;
}

export function saveDocument(path: string, bytes: Uint8Array): boolean {
  let overwritten = false;
  let mode: number | undefined;
  let fd: number | undefined;
  let staged = false;
  const temporary = join(dirname(path), `.omp-document-${randomUUID()}.tmp`);
  try {
    let existing;
    try { existing = lstatSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (existing) {
      if (!existing.isFile()) throw new PermanentDocumentPreparationError('The document destination is not a regular file.');
      // Opening without truncation checks file write permission, not just directory rename permission.
      fd = openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const current = fstatSync(fd);
      if (!current.isFile()) throw new PermanentDocumentPreparationError('The document destination is not a regular file.');
      mode = current.mode & 0o777;
      const destinationFd = fd;
      fd = undefined;
      closeSync(destinationFd);
      overwritten = true;
    }
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o666);
    staged = true;
    if (mode !== undefined) fchmodSync(fd, mode);
    writeFileSync(fd, bytes);
    const temporaryFd = fd;
    fd = undefined;
    closeSync(temporaryFd);
    renameSync(temporary, path);
    staged = false;
    return overwritten;
  } catch (error) {
    const errors: unknown[] = [error];
    if (fd !== undefined) {
      try { closeSync(fd); } catch (closeError) { errors.push(closeError); }
    }
    if (staged) {
      try { unlinkSync(temporary); } catch (unlinkError) { errors.push(unlinkError); }
    }
    if (errors.length === 1) throw error;
    const diagnostic = errors.map(failure => failure instanceof Error ? failure.message : String(failure)).join('\n');
    if (error instanceof PermanentDocumentPreparationError)
      throw new PermanentDocumentPreparationError(diagnostic, {cause: new AggregateError(errors)});
    throw new AggregateError(errors, diagnostic);
  }
}
