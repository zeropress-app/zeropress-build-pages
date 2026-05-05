import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, '..');
const actionPath = path.join(packageDir, 'dist', 'action.js');

await build({
  entryPoints: [path.join(packageDir, 'src', 'action.js')],
  outfile: actionPath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'bundle',
  banner: {
    js: '#!/usr/bin/env node',
  },
});

console.log(`Wrote ${path.relative(packageDir, actionPath)}`);
