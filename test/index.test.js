import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkInternalLinks } from '../src/check-links.js';
import { parseArgs, runBuildPages } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, '..');
const binPath = path.join(packageDir, 'bin', 'zeropress-build-pages.js');
const actionPath = path.join(packageDir, 'dist', 'action.js');
const fixtureRoot = path.join(packageDir, 'test', 'fixtures', 'prebuild-errors');
const prebuildScript = path.join(packageDir, 'src', 'prebuild.js');

test('CLI prints help and version', () => {
  const help = spawnSync(process.execPath, [binPath, '--help'], {
    cwd: packageDir,
    encoding: 'utf8',
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /zeropress-build-pages/);
  assert.match(help.stdout, /--source <dir>/);
  assert.match(help.stdout, /Source directory \(required, or ZEROPRESS_PUBLIC_DIR\)/);

  const version = spawnSync(process.execPath, [binPath, '--version'], {
    cwd: packageDir,
    encoding: 'utf8',
  });
  assert.equal(version.status, 0);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('parseArgs applies CLI, env, and default precedence', () => {
  assert.throws(
    () => parseArgs([], {}),
    /--source <dir> is required/,
  );
  assert.throws(
    () => parseArgs(['--source', 'docs'], {}),
    /--destination <dir> is required/,
  );
  assert.throws(
    () => parseArgs(['--source', 'docs', '--out', '_site'], {}),
    /unknown option --out/,
  );

  assert.deepEqual(parseArgs([], {
    ZEROPRESS_PUBLIC_DIR: 'docs',
    ZEROPRESS_OUT_DIR: 'site',
    ZEROPRESS_THEME_DIR: 'theme',
    ZEROPRESS_SITE_URL: 'https://example.com',
    ZEROPRESS_SKIP_UNTITLED_MARKDOWN: 'true',
  }), {
    source: 'docs',
    destination: 'site',
    theme: 'docs',
    themePath: 'theme',
    config: '',
    siteUrl: 'https://example.com',
    skipUntitledMarkdown: true,
    checkLinks: true,
  });

  const parsed = parseArgs([
    '--source', 'src',
    '--destination', 'dist',
    '--theme-path', 'custom-theme',
    '--site-url', 'https://override.example',
    '--skip-untitled-markdown',
    '--no-check-links',
  ], {
    ZEROPRESS_PUBLIC_DIR: 'docs',
    ZEROPRESS_OUT_DIR: 'site',
  });
  assert.equal(parsed.source, 'src');
  assert.equal(parsed.destination, 'dist');
  assert.equal(parsed.themePath, 'custom-theme');
  assert.equal(parsed.siteUrl, 'https://override.example');
  assert.equal(parsed.skipUntitledMarkdown, true);
  assert.equal(parsed.checkLinks, false);
});

const failureCases = [
  'invalid-front-page-type',
  'invalid-html-front-page-path',
  'missing-html-front-page-file',
  'missing-custom-html-file',
  'missing-h1',
  'empty-markdown',
];

for (const caseName of failureCases) {
  test(`prebuild error output: ${caseName}`, () => {
    const result = runPrebuild(caseName);

    assert.notEqual(result.status, 0);
    assert.equal(normalizeOutput(result.stderr), readExpected(caseName, 'expected.stderr.txt'));
    assert.equal(normalizeOutput(result.stdout), '');
    assert.doesNotMatch(result.stderr, /at async|at main|Error:/);
  });
}

test('prebuild warning output: skip untitled markdown', () => {
  const result = runPrebuild('skip-untitled', {
    ZEROPRESS_SKIP_UNTITLED_MARKDOWN: 'true',
  });

  assert.equal(result.status, 0);
  assert.equal(normalizeOutput(result.stderr), readExpected('skip-untitled', 'expected.stderr.txt'));
  assert.equal(normalizeOutput(result.stdout), readExpected('skip-untitled', 'expected.stdout.txt'));
});

test('builds a source root without config and preserves markdown passthrough', async () => {
  const tempDir = await makeTempDir();
  await fs.writeFile(path.join(tempDir, 'index.md'), [
    '# Home',
    '',
    'Welcome to the docs. See [Guide](guide.md).',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(tempDir, 'guide.md'), [
    '# Guide',
    '',
    '- [x] Built with ZeroPress.',
  ].join('\n'), 'utf8');

  await runBuildPages({
    cwd: tempDir,
    source: '.',
    destination: '_site',
    theme: 'docs',
    checkLinks: true,
  });

  const indexHtml = await fs.readFile(path.join(tempDir, '_site', 'index.html'), 'utf8');
  const guideHtml = await fs.readFile(path.join(tempDir, '_site', 'guide.html'), 'utf8');
  assert.match(indexHtml, /href="\/guide"/);
  assert.match(guideHtml, /contains-task-list/);
  await fs.access(path.join(tempDir, '_site', 'guide.md'));
  await fs.access(path.join(tempDir, '.zeropress', 'preview-data.json'));
});

test('builds with config, custom theme path, and source inside a subdirectory', async () => {
  const tempDir = await makeTempDir();
  const sourceDir = path.join(tempDir, 'docs');
  await fs.mkdir(path.join(sourceDir, '.zeropress'), { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'index.md'), '# Home\n\nConfigured home.', 'utf8');
  await fs.writeFile(path.join(sourceDir, 'topic.md'), '# Topic\n\nContent.', 'utf8');
  await fs.writeFile(path.join(sourceDir, '.zeropress', 'config.json'), JSON.stringify({
    version: '0.1',
    site: {
      title: 'Configured Docs',
      description: 'A configured docs site.',
      footer: {
        copyright_text: 'Copyright 2026 Example Corp.',
        attribution: {
          enabled: false,
        },
      },
    },
    front_page: {
      type: 'markdown',
    },
    menus: {
      primary: {
        name: 'Primary Menu',
        items: [
          { title: 'Home', url: '/' },
          { title: 'Topic', url: '/topic' },
        ],
      },
    },
  }, null, 2), 'utf8');

  await runBuildPages({
    cwd: tempDir,
    source: 'docs',
    destination: '_site',
    theme: 'docs',
    themePath: path.join(packageDir, 'themes', 'docs'),
    checkLinks: false,
  });

  const indexHtml = await fs.readFile(path.join(tempDir, '_site', 'index.html'), 'utf8');
  assert.match(indexHtml, /Configured Docs/);
  assert.match(indexHtml, /Copyright 2026 Example Corp\./);
  assert.doesNotMatch(indexHtml, /Published with/);
  const previewData = JSON.parse(await fs.readFile(path.join(tempDir, '.zeropress', 'preview-data.json'), 'utf8'));
  assert.equal(previewData.$schema, 'https://zeropress.dev/schemas/preview-data.v0.5.schema.json');
  assert.deepEqual(previewData.site.footer, {
    copyright_text: 'Copyright 2026 Example Corp.',
    attribution: {
      enabled: false,
    },
  });
  await fs.access(path.join(tempDir, '_site', 'topic.html'));
  await fs.access(path.join(tempDir, '_site', 'topic.md'));
});

test('link checker reports broken links without throwing', async () => {
  const tempDir = await makeTempDir();
  const siteDir = path.join(tempDir, '_site');
  await fs.mkdir(siteDir, { recursive: true });
  await fs.writeFile(path.join(siteDir, 'index.html'), '<a href="/missing">Missing</a>', 'utf8');

  const result = await checkInternalLinks(siteDir);
  assert.equal(result.htmlFiles.length, 1);
  assert.deepEqual(result.brokenLinks, ['index.html -> /missing']);
});

test('action metadata and entrypoint use supported inputs', async () => {
  const action = await fs.readFile(path.join(packageDir, 'action.yml'), 'utf8');
  for (const inputName of ['source', 'destination', 'theme', 'theme-path', 'config', 'site-url', 'skip-untitled-markdown', 'check-links']) {
    assert.match(action, new RegExp(`\\n  ${inputName}:`));
  }
  assert.match(action, /default: \.\/docs/);

  const tempDir = await makeTempDir();
  await fs.mkdir(path.join(tempDir, 'docs'), { recursive: true });
  await fs.writeFile(path.join(tempDir, 'docs', 'index.md'), '# Home\n\nAction build.', 'utf8');
  const result = spawnSync(process.execPath, [actionPath], {
    cwd: tempDir,
    env: {
      ...process.env,
      INPUT_DESTINATION: '_site',
      INPUT_THEME: 'docs',
      INPUT_CHECK_LINKS: 'false',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  await fs.access(path.join(tempDir, '_site', 'index.html'));
});

function runPrebuild(caseName, env = {}) {
  const fixtureDir = path.join(fixtureRoot, caseName);
  return spawnSync(process.execPath, [prebuildScript], {
    cwd: packageDir,
    env: {
      ...process.env,
      ZEROPRESS_BUILD_PAGES_SOURCE: path.join(fixtureDir, 'documents'),
      ZEROPRESS_SKIP_UNTITLED_MARKDOWN: 'false',
      ...env,
    },
    encoding: 'utf8',
  });
}

function readExpected(caseName, fileName) {
  return normalizeOutput(
    fsSync.readFileSync(path.join(fixtureRoot, caseName, fileName), 'utf8')
      .replaceAll('[zeropress-prebuild]', '[zeropress-build-pages]'),
  );
}

function normalizeOutput(value) {
  return String(value || '').replace(/\r\n/g, '\n').trimEnd();
}

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-build-pages-'));
}
