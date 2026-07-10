import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkInternalLinks } from '../src/check-links.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, '..');
const actionPaths = [
  path.join(packageDir, 'src', 'action.js'),
  path.join(packageDir, 'dist', 'action.js'),
];

test('source and bundled actions reject invalid boolean inputs', () => {
  const cases = [
    ['skip-untitled-markdown', 'yes'],
    ['skip-link-check', '0'],
    ['copy-markdown-source', 'flase'],
    ['copy-markdown-source', 'FALSE'],
  ];

  for (const actionPath of actionPaths) {
    for (const [name, value] of cases) {
      const result = spawnSync(process.execPath, [actionPath], {
        cwd: packageDir,
        env: actionEnv({ [`INPUT_${name.toUpperCase()}`]: value }),
        encoding: 'utf8',
      });

      assert.equal(result.status, 1, `${path.basename(actionPath)}: ${name} should reject ${value}`);
      assert.match(result.stderr, new RegExp(`Invalid boolean input "${name}"`));
      assert.match(result.stderr, /expected "true" or "false"/);
    }
  }
});

test('bundled action accepts exact true and false boolean inputs', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-action-inputs-'));
  await fs.mkdir(path.join(tempDir, 'docs'));
  await fs.writeFile(path.join(tempDir, 'docs', 'index.md'), '# Home\n', 'utf8');

  const result = spawnSync(process.execPath, [actionPaths[1]], {
    cwd: tempDir,
    env: actionEnv({
      'INPUT_SKIP-UNTITLED-MARKDOWN': 'false',
      'INPUT_SKIP-LINK-CHECK': 'true',
      'INPUT_COPY-MARKDOWN-SOURCE': 'false',
    }),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  await fs.access(path.join(tempDir, '_site', 'index.html'));
  await assert.rejects(fs.access(path.join(tempDir, '_site', 'index.md')), { code: 'ENOENT' });
});

test('link checker reports malformed and ENOTDIR targets as broken links', async () => {
  const siteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-link-errors-'));
  const tooLongTarget = `/${'a'.repeat(300)}`;
  await fs.writeFile(path.join(siteDir, 'asset'), 'file', 'utf8');
  await fs.writeFile(path.join(siteDir, 'index.html'), [
    '<a href="/asset/child">Not a directory</a>',
    '<a href="/%00">Decoded NUL</a>',
    '<a href="/%E0%A4%A">Malformed encoding</a>',
    `<a href="${tooLongTarget}">Too long</a>`,
  ].join('\n'), 'utf8');

  const result = await checkInternalLinks(siteDir);

  assert.deepEqual(result.brokenLinks.sort(), [
    'index.html -> /%00',
    'index.html -> /%E0%A4%A',
    `index.html -> ${tooLongTarget}`,
    'index.html -> /asset/child',
  ]);
});

test('link checker propagates genuine filesystem failures', {
  skip: process.platform === 'win32' ? 'symlink creation is not consistently available on Windows' : false,
}, async () => {
  const siteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-link-io-'));
  await fs.writeFile(path.join(siteDir, 'index.html'), '<a href="/loop/child">Loop</a>', 'utf8');
  await fs.symlink('loop', path.join(siteDir, 'loop'));

  await assert.rejects(checkInternalLinks(siteDir), { code: 'ELOOP' });
});

function actionEnv(inputs) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('INPUT_')),
  );
  return { ...env, ...inputs };
}
