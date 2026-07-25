import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runBuildPages } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, '..');
const prebuildScript = path.join(packageDir, 'src', 'prebuild.js');

test('canonical path checks reject a destination alias before source cleanup', {
  skip: process.platform === 'win32' ? 'symlink creation is not consistently available on Windows' : false,
}, async () => {
  const cwd = await makeTempDir('zeropress-path-alias-');
  const sourceDir = path.join(cwd, 'docs');
  await fs.mkdir(sourceDir);
  await fs.writeFile(path.join(sourceDir, 'index.md'), '# Home\n', 'utf8');
  await fs.writeFile(path.join(sourceDir, 'KEEP.txt'), 'keep', 'utf8');
  await fs.symlink('.', path.join(cwd, 'alias'), 'dir');

  await assert.rejects(
    runBuildPages({
      cwd,
      source: 'docs',
      destination: 'alias/docs',
      theme: 'plain',
      skipLinkCheck: true,
    }),
    /Source directory must not overlap the destination directory/,
  );

  assert.equal(await fs.readFile(path.join(sourceDir, 'KEEP.txt'), 'utf8'), 'keep');
});

test('canonical path checks reject a destination alias to a custom theme', {
  skip: process.platform === 'win32' ? 'symlink creation is not consistently available on Windows' : false,
}, async () => {
  const cwd = await makeTempDir('zeropress-theme-alias-');
  const sourceDir = path.join(cwd, 'docs');
  const themeDir = path.join(cwd, 'theme');
  await fs.mkdir(sourceDir);
  await fs.mkdir(themeDir);
  await fs.writeFile(path.join(sourceDir, 'index.md'), '# Home\n', 'utf8');
  await fs.writeFile(path.join(themeDir, 'KEEP.txt'), 'keep', 'utf8');
  await fs.symlink('.', path.join(cwd, 'alias'), 'dir');

  await assert.rejects(
    runBuildPages({
      cwd,
      source: 'docs',
      destination: 'alias/theme',
      themePath: 'theme',
      skipLinkCheck: true,
    }),
    /Theme directory must not overlap the destination directory/,
  );

  assert.equal(await fs.readFile(path.join(themeDir, 'KEEP.txt'), 'utf8'), 'keep');
});

test('source directory root symlinks are rejected before public staging', {
  skip: process.platform === 'win32' ? 'symlink creation is not consistently available on Windows' : false,
}, async () => {
  const cwd = await makeTempDir('zeropress-source-symlink-');
  const contentDir = path.join(cwd, 'content');
  await fs.mkdir(contentDir);
  await fs.writeFile(path.join(contentDir, 'index.md'), '# Home\n', 'utf8');
  await fs.writeFile(path.join(contentDir, 'private.json'), '{"private":true}', 'utf8');
  await fs.symlink('content', path.join(cwd, 'docs'), 'dir');

  await assert.rejects(
    runBuildPages({
      cwd,
      source: 'docs',
      destination: '_site',
      theme: 'plain',
      skipLinkCheck: true,
    }),
    /Source directory must not be a symbolic link/,
  );

  await assert.rejects(fs.access(path.join(cwd, '_site', 'private.json')), { code: 'ENOENT' });
});

test('configured HTML symlinks cannot escape the source .zeropress directory', {
  skip: process.platform === 'win32' ? 'symlink creation is not consistently available on Windows' : false,
}, async () => {
  const cwd = await makeTempDir('zeropress-html-symlink-');
  const sourceDir = path.join(cwd, 'docs');
  await fs.mkdir(path.join(sourceDir, '.zeropress'), { recursive: true });
  await fs.writeFile(path.join(cwd, 'secret.html'), '<p>secret</p>', 'utf8');
  await fs.symlink('../../secret.html', path.join(sourceDir, '.zeropress', 'leak.html'));
  await fs.writeFile(path.join(sourceDir, '.zeropress', 'config.json'), JSON.stringify({
    version: '1.0',
    front_page: {
      type: 'html',
      file: '.zeropress/leak.html',
      layout: false,
    },
  }), 'utf8');

  const result = runPrebuild(cwd, sourceDir);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /front_page\.file must resolve to an HTML file inside the source \.zeropress directory/);
  await assert.rejects(fs.access(path.join(cwd, '.zeropress-build-pages', 'preview-data.json')), { code: 'ENOENT' });
});

test('a non-index Markdown front page is the link-rewrite target for its source file', async () => {
  const cwd = await makeTempDir('zeropress-front-page-route-');
  const sourceDir = path.join(cwd, 'docs');
  await fs.mkdir(path.join(sourceDir, '.zeropress'), { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'home.md'), '# Home\n', 'utf8');
  await fs.writeFile(path.join(sourceDir, 'guide.md'), '# Guide\n\n[Home](home.md)\n', 'utf8');
  await fs.writeFile(path.join(sourceDir, '.zeropress', 'config.json'), JSON.stringify({
    version: '1.0',
    front_page: {
      type: 'markdown',
      file: 'home.md',
    },
  }), 'utf8');

  await runBuildPages({
    cwd,
    source: 'docs',
    destination: '_site',
    theme: 'plain',
    skipLinkCheck: false,
    copyMarkdownSource: false,
  });

  const guideHtml = await fs.readFile(path.join(cwd, '_site', 'guide.html'), 'utf8');
  assert.match(guideHtml, /href="\/"/);
  assert.doesNotMatch(guideHtml, /href="\/home"/);
  await assert.rejects(fs.access(path.join(cwd, '_site', 'home.html')), { code: 'ENOENT' });
});

test('headings inside fenced code do not satisfy the page-title requirement', async () => {
  const cwd = await makeTempDir('zeropress-fenced-title-');
  const sourceDir = path.join(cwd, 'docs');
  await fs.mkdir(sourceDir);
  await fs.writeFile(path.join(sourceDir, 'shell.md'), [
    '```sh',
    '# shell comment',
    '```',
  ].join('\n'), 'utf8');

  const result = runPrebuild(cwd, sourceDir);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing top-level heading/);
  await assert.rejects(fs.access(path.join(cwd, '.zeropress-build-pages', 'preview-data.json')), { code: 'ENOENT' });
});

test('an explicitly configured missing config path is an error', async () => {
  const cwd = await makeTempDir('zeropress-missing-config-');
  const sourceDir = path.join(cwd, 'docs');
  const missingConfigPath = path.join(cwd, 'missing.json');
  await fs.mkdir(sourceDir);
  await fs.writeFile(path.join(sourceDir, 'index.md'), '# Home\n', 'utf8');

  const result = runPrebuild(cwd, sourceDir, {
    ZEROPRESS_BUILD_PAGES_CONFIG: missingConfigPath,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /configured config file does not exist/);
  assert.match(result.stderr, /missing\.json/);
  await assert.rejects(fs.access(path.join(cwd, '.zeropress-build-pages', 'preview-data.json')), { code: 'ENOENT' });
});

test('front matter mappings keep prototype-named keys as own data properties', async () => {
  for (const scriptPath of [
    prebuildScript,
    path.join(packageDir, 'dist', 'prebuild.js'),
  ]) {
    const cwd = await makeTempDir('zeropress-yaml-prototype-');
    const sourceDir = path.join(cwd, 'docs');
    await fs.mkdir(sourceDir);
    await fs.writeFile(path.join(sourceDir, 'index.md'), [
      '---',
      '__proto__:',
      '  status: draft',
      '  title: Poisoned title',
      '  path: poisoned',
      'constructor: ignored-root-value',
      'prototype: ignored-root-value',
      'data:',
      '  block:',
      '    __proto__: block-value',
      '  inline: {__proto__: inline-value, constructor: constructor-value, prototype: prototype-value}',
      '---',
      '',
      '# Safe title',
    ].join('\n'), 'utf8');

    const result = runPrebuild(cwd, sourceDir, {}, scriptPath);
    assert.equal(result.status, 0, `${scriptPath}\n${result.stderr}`);

    const previewData = JSON.parse(await fs.readFile(
      path.join(cwd, '.zeropress-build-pages', 'preview-data.json'),
      'utf8',
    ));
    const page = previewData.content.pages[0];
    assert.equal(page.title, 'Safe title');
    assert.equal(page.slug, 'index');
    assert.notEqual(page.path, 'poisoned');
    assert.equal(Object.hasOwn(page.data.block, '__proto__'), true);
    assert.equal(page.data.block.__proto__, 'block-value');
    assert.equal(Object.hasOwn(page.data.inline, '__proto__'), true);
    assert.equal(page.data.inline.__proto__, 'inline-value');
    assert.equal(page.data.inline.constructor, 'constructor-value');
    assert.equal(page.data.inline.prototype, 'prototype-value');
  }
});

test('prebuild diagnostics escape controls in source paths and config keys', async () => {
  const cwd = await makeTempDir('zeropress-terminal-');
  const sourceDir = path.join(cwd, 'docs');
  await fs.mkdir(path.join(sourceDir, '.zeropress'), { recursive: true });
  const unsafeName = `bad\n\u001b\u0085\u202E.md`;
  await fs.writeFile(path.join(sourceDir, unsafeName), 'No heading\n', 'utf8');

  const pathResult = runPrebuild(cwd, sourceDir);
  assert.notEqual(pathResult.status, 0);
  assert.doesNotMatch(pathResult.stderr, /[\u001b\u0085\u202E]/u);
  assert.match(pathResult.stderr, /bad\\u000A\\u001B\\u0085\\u202E\.md/);

  await fs.rm(path.join(sourceDir, unsafeName));
  await fs.writeFile(path.join(sourceDir, 'index.md'), '# Home\n', 'utf8');
  await fs.writeFile(path.join(sourceDir, '.zeropress', 'config.json'), JSON.stringify({
    version: '1.0',
    [`unsafe\u001b\u0085\u202Ekey`]: true,
  }), 'utf8');

  const configResult = runPrebuild(cwd, sourceDir);
  assert.notEqual(configResult.status, 0);
  assert.doesNotMatch(configResult.stderr, /[\u001b\u0085\u202E]/u);
  assert.match(configResult.stderr, /unsafe\\u001B\\u0085\\u202Ekey/);
});

function runPrebuild(cwd, sourceDir, extraEnv = {}, scriptPath = prebuildScript) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd,
    env: {
      ...process.env,
      ZEROPRESS_BUILD_PAGES_SOURCE: sourceDir,
      ZEROPRESS_SKIP_UNTITLED_MARKDOWN: 'false',
      ...extraEnv,
    },
    encoding: 'utf8',
  });
}

function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}
