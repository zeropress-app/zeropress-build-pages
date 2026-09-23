import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const themes = ['docs1', 'docs2', 'plain'];

for (const theme of themes) {
  test(`${theme} theme presents WordPress-compatible image alignment`, async () => {
    const css = await fs.readFile(
      path.join(packageRoot, 'themes', theme, 'assets', 'style.css'),
      'utf8',
    );

    assert.match(css, /img\.alignleft\s*\{[\s\S]*?float:\s*left;/u);
    assert.match(css, /img\.aligncenter\s*\{[\s\S]*?float:\s*none;/u);
    assert.match(css, /img\.alignright\s*\{[\s\S]*?float:\s*right;/u);
    assert.match(
      css,
      /@media \(max-width:\s*640px\)[\s\S]*?img\.alignleft,[\s\S]*?img\.alignright\s*\{[\s\S]*?float:\s*none;/u,
    );
  });
}
