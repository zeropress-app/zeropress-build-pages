import { build } from 'esbuild';
import fs from 'node:fs/promises';
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

await Promise.all([
  removeGeneratedTrailingWhitespace(actionPath),
  removeGeneratedTrailingWhitespace(prebuildPath),
]);

console.log(`Wrote ${path.relative(packageDir, actionPath)}`);
console.log(`Wrote ${path.relative(packageDir, prebuildPath)}`);

async function removeGeneratedTrailingWhitespace(filePath) {
  const source = await fs.readFile(filePath, 'utf8');
  const normalized = source.replace(/[ \t]+$/gm, '');
  if (normalized !== source) {
    await fs.writeFile(filePath, normalized, 'utf8');
  }
}
