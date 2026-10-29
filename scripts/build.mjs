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
await Promise.all(['host-supervisor.mjs','host-lifecycle.mjs'].map(name => copyFile(`src/${name}`,`dist/${name}`)));
await chmod('dist/cli.js', 0o755);
