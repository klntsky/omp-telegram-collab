import { build } from 'esbuild';
import { copyFile, chmod } from 'node:fs/promises';

await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: true,
  external: ['@lydell/node-pty', 'grammy', 'ws', 'zod', 'yaml', 'abort-controller'],
});
await build({
  entryPoints: ['src/relay-daemon.ts'],
  outfile: 'dist/relay-daemon.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external: ['ws'],
});
await Promise.all(['host-supervisor.mjs','host-lifecycle.mjs'].map(name => copyFile(`src/${name}`,`dist/${name}`)));
await chmod('dist/cli.js', 0o755);
