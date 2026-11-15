import { Context } from 'grammy';

const albums = new WeakMap<Context, readonly Context[]>();

export function restoreFolderAlbum(source: Context, updates: readonly Context['update'][]): void {
  albums.set(source,updates.map(update => new Context(update,source.api,source.me)));
}

export function folderAlbumContexts(source: Context, fallback: readonly Context[]): readonly Context[] {
  return albums.get(source) ?? fallback;
}
