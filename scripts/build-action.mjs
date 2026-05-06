import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, '..');
const actionPath = path.join(packageDir, 'dist', 'action.js');
const prebuildPath = path.join(packageDir, 'dist', 'prebuild.js');

const sharedOptions = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'bundle',
  banner: {
    js: [
      '#!/usr/bin/env node',
      'import { createRequire as __zeropressCreateRequire } from "node:module";',
      'const require = __zeropressCreateRequire(import.meta.url);',
    ].join('\n'),
  },
};

await build({
  ...sharedOptions,
  entryPoints: [path.join(packageDir, 'src', 'action.js')],
  outfile: actionPath,
});

await build({
  ...sharedOptions,
  entryPoints: [path.join(packageDir, 'src', 'prebuild.js')],
  outfile: prebuildPath,
});

console.log(`Wrote ${path.relative(packageDir, actionPath)}`);
console.log(`Wrote ${path.relative(packageDir, prebuildPath)}`);
