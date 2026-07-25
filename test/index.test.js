import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkInternalLinks } from '../src/check-links.js';
import {
  formatBuildPagesBanner,
  formatBuildPagesSuccessMessage,
  parseArgs,
  runBuildPages,
} from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, '..');
const binPath = path.join(packageDir, 'bin', 'zeropress-build-pages.js');
const actionPath = path.join(packageDir, 'dist', 'action.js');
const bundledPrebuildPath = path.join(packageDir, 'dist', 'prebuild.js');
const fixtureRoot = path.join(packageDir, 'test', 'fixtures', 'prebuild-errors');
const prebuildScript = path.join(packageDir, 'src', 'prebuild.js');
const sourceIndexPath = path.join(packageDir, 'src', 'index.js');

test('uses the official @zeropress/build package entrypoint', async () => {
  const [packageJson, sourceIndex] = await Promise.all([
    fs.readFile(path.join(packageDir, 'package.json'), 'utf8').then(JSON.parse),
    fs.readFile(sourceIndexPath, 'utf8'),
  ]);

  assert.equal(packageJson.dependencies['@zeropress/build'], '0.7.1');
  assert.match(sourceIndex, /from '@zeropress\/build';/);
  assert.doesNotMatch(sourceIndex, /@zeropress\/build\/src\//);
});

async function readBundledThemeId(themeName) {
  const manifest = JSON.parse(await fs.readFile(path.join(packageDir, 'themes', themeName, 'theme.json'), 'utf8'));
  return `${manifest.namespace}.${manifest.slug}@${manifest.version}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function withColorEnv(env, fn) {
  const previousForceColor = process.env.FORCE_COLOR;
  const previousNoColor = process.env.NO_COLOR;

  if ('FORCE_COLOR' in env) {
    process.env.FORCE_COLOR = env.FORCE_COLOR;
  } else {
    delete process.env.FORCE_COLOR;
  }

  if ('NO_COLOR' in env) {
    process.env.NO_COLOR = env.NO_COLOR;
  } else {
    delete process.env.NO_COLOR;
  }

  try {
    return fn();
  } finally {
    if (previousForceColor === undefined) {
      delete process.env.FORCE_COLOR;
    } else {
      process.env.FORCE_COLOR = previousForceColor;
    }

    if (previousNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = previousNoColor;
    }
  }
}

test('formatBuildPagesSuccessMessage uses success color when color is enabled', () => {
  const message = withColorEnv({ FORCE_COLOR: '1' }, () => (
    formatBuildPagesSuccessMessage({ isTTY: false })
  ));

  assert.equal(message, '\x1b[32mBuilt ZeroPress Pages site successfully\x1b[0m');
});

test('formatBuildPagesBanner uses bold cyan color when color is enabled', () => {
  const message = withColorEnv({ FORCE_COLOR: '1' }, () => (
    formatBuildPagesBanner('0.6.7', { isTTY: false })
  ));

  assert.equal(message, '\x1b[1;36mZeroPress Build Pages 0.6.7\x1b[0m');
});

test('CLI prints help and version', () => {
  const noArgs = spawnSync(process.execPath, [binPath], {
    cwd: packageDir,
    encoding: 'utf8',
  });
  assert.equal(noArgs.status, 0);
  assert.match(noArgs.stdout, /zeropress-build-pages/);
  assert.match(noArgs.stdout, /--source <dir>/);
  assert.equal(noArgs.stderr, '');

  const help = spawnSync(process.execPath, [binPath, '--help'], {
    cwd: packageDir,
    encoding: 'utf8',
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /zeropress-build-pages/);
  assert.match(help.stdout, /--source <dir>/);
  assert.match(help.stdout, /--public-dir <dir>/);
  assert.match(help.stdout, /Dedicated source directory \(required\)/);

  const version = spawnSync(process.execPath, [binPath, '--version'], {
    cwd: packageDir,
    encoding: 'utf8',
  });
  assert.equal(version.status, 0);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('CLI errors escape terminal control characters', () => {
  const env = {
    ...process.env,
    NO_COLOR: '1',
  };
  delete env.FORCE_COLOR;

  const result = spawnSync(process.execPath, [
    binPath,
    `--unknown\n\u001b\u0085\u202Eoption`,
  ], {
    cwd: packageDir,
    encoding: 'utf8',
    env,
  });

  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /[\u001b\u0085\u202E]/u);
  assert.match(result.stderr, /--unknown\\u000A\\u001B\\u0085\\u202Eoption/);
});

test('parseArgs requires explicit CLI options and applies flag defaults', () => {
  assert.throws(
    () => parseArgs([]),
    /--source <dir> is required/,
  );
  assert.throws(
    () => parseArgs(['--source', 'docs']),
    /--destination <dir> is required/,
  );
  assert.throws(
    () => parseArgs(['--source', 'docs', '--public-dir', '--destination', '_site']),
    /--public-dir requires a value/,
  );
  assert.throws(
    () => parseArgs(['--source', 'docs', '--out', '_site']),
    /unknown option --out/,
  );
  assert.throws(
    () => parseArgs(['--source', 'docs', '--destination', '_site', '--no-check-links']),
    /unknown option --no-check-links/,
  );
  assert.throws(
    () => parseArgs(['--source', 'docs', '--destination', '_site', '--copy-markdown-source']),
    /unknown option --copy-markdown-source/,
  );
  assert.throws(
    () => parseArgs(['foobar']),
    /unexpected positional argument: foobar/,
  );

  assert.deepEqual(parseArgs(['--source', 'docs', '--destination', 'site']), {
    source: 'docs',
    publicDir: '',
    destination: 'site',
    theme: 'docs',
    themePath: '',
    config: '',
    siteUrl: '',
    skipUntitledMarkdown: false,
    skipLinkCheck: false,
    copyMarkdownSource: true,
  });

  assert.throws(
    () => parseArgs([], {
      ZEROPRESS_PUBLIC_DIR: 'docs',
      ZEROPRESS_OUT_DIR: 'site',
      ZEROPRESS_THEME_DIR: 'theme',
      ZEROPRESS_SITE_URL: 'https://example.com',
      ZEROPRESS_SKIP_UNTITLED_MARKDOWN: 'true',
      ZEROPRESS_SKIP_LINK_CHECK: 'true',
    }),
    /--source <dir> is required/,
  );

  const parsed = parseArgs([
    '--source', 'src',
    '--destination', 'dist',
    '--theme-path', 'custom-theme',
    '--site-url', 'https://override.example',
    '--skip-untitled-markdown',
    '--skip-link-check',
    '--no-copy-markdown-source',
  ]);
  assert.equal(parsed.source, 'src');
  assert.equal(parsed.publicDir, '');
  assert.equal(parsed.destination, 'dist');
  assert.equal(parsed.themePath, 'custom-theme');
  assert.equal(parsed.siteUrl, 'https://override.example');
  assert.equal(parsed.skipUntitledMarkdown, true);
  assert.equal(parsed.skipLinkCheck, true);
  assert.equal(parsed.copyMarkdownSource, false);

  const publicParsed = parseArgs([
    '--source', 'src',
    '--public-dir', 'public',
    '--destination', 'dist',
  ]);
  assert.equal(publicParsed.publicDir, 'public');
});

test('bundled theme docs aliases docs1, docs2, plain builds, and unknown themes list supported names', async () => {
  const tempDir = await makeTempDir();
  await fs.mkdir(path.join(tempDir, 'docs'), { recursive: true });
  await fs.writeFile(path.join(tempDir, 'docs', 'index.md'), '# Home\n\nAlias build.', 'utf8');

  await runBuildPages({
    cwd: tempDir,
    source: 'docs',
    destination: '_site',
    theme: 'docs1',
    skipLinkCheck: true,
  });

  await fs.access(path.join(tempDir, '_site', 'index.html'));

  await runBuildPages({
    cwd: tempDir,
    source: 'docs',
    destination: '_site-docs2',
    theme: 'docs2',
    skipLinkCheck: true,
  });

  await fs.access(path.join(tempDir, '_site-docs2', 'index.html'));

  await runBuildPages({
    cwd: tempDir,
    source: 'docs',
    destination: '_site-plain',
    theme: 'plain',
    skipLinkCheck: true,
  });

  await fs.access(path.join(tempDir, '_site-plain', 'index.html'));

  await assert.rejects(
    runBuildPages({
      cwd: tempDir,
      source: 'docs',
      destination: '_site',
      theme: 'missing-theme',
      skipLinkCheck: true,
    }),
    /Unknown bundled theme: missing-theme\. Supported bundled themes: docs, docs1, docs2, plain/,
  );
});

const failureCases = [
  'invalid-front-page-type',
  'invalid-html-front-page-path',
  'missing-html-front-page-file',
  'missing-custom-html-file',
  'invalid-site-indexing',
  'invalid-site-search',
  'invalid-site-expose-generator',
  'invalid-site-logo',
  'invalid-site-locale',
  'invalid-site-meta',
  'invalid-site-url',
  'invalid-menu-meta',
  'removed-site-field',
  'malformed-front-matter',
  'invalid-front-matter-path',
  'invalid-front-matter-discoverability',
  'invalid-front-matter-meta',
  'invalid-front-matter-data',
  'unsupported-front-matter-language',
  'unsafe-yaml-tag',
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

test('prebuild rejects non-origin-root site URL overrides', () => {
  for (const siteUrl of [
    'https://example.com/docs',
    'https://example.com?preview=true',
    'https://example.com?',
    'https://example.com#docs',
    'https://example.com#',
    'ftp://example.com',
  ]) {
    const result = runPrebuild('skip-untitled', {
      ZEROPRESS_SITE_URL: siteUrl,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /site\.url must (?:use the origin root|be an absolute http: or https: URL)/);
    assert.equal(normalizeOutput(result.stdout), '');
  }
});

test('build allows an explicitly empty site URL', async () => {
  const tempDir = await makeTempDir();
  const sourceDir = path.join(tempDir, 'docs');
  await fs.mkdir(path.join(sourceDir, '.zeropress'), { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'index.md'), '# Home\n\nContent.', 'utf8');
  await fs.writeFile(path.join(sourceDir, '.zeropress', 'config.json'), JSON.stringify({
    version: '1.0',
    site: {
      url: '',
    },
    front_page: {
      type: 'markdown',
    },
  }, null, 2), 'utf8');

  await runBuildPages({
    cwd: tempDir,
    source: 'docs',
    destination: '_site',
    theme: 'plain',
    skipLinkCheck: true,
  });

  const previewData = JSON.parse(await fs.readFile(
    path.join(tempDir, '.zeropress-build-pages', 'preview-data.json'),
    'utf8',
  ));
  assert.equal(previewData.site.url, '');
  assert.equal(await pathExists(path.join(tempDir, '_site', 'sitemap.xml')), false);
});

test('prebuild warning output: skip untitled markdown', () => {
  const result = runPrebuild('skip-untitled', {
    ZEROPRESS_SKIP_UNTITLED_MARKDOWN: 'true',
  });

  assert.equal(result.status, 0);
  assert.equal(normalizeOutput(result.stderr), readExpected('skip-untitled', 'expected.stderr.txt'));
  assert.equal(normalizeOutput(result.stdout), readExpected('skip-untitled', 'expected.stdout.txt'));
});

test('prebuild warning output: invalid front matter status', () => {
  const result = runPrebuild('invalid-front-matter-status');

  assert.equal(result.status, 0);
  assert.equal(normalizeOutput(result.stderr), readExpected('invalid-front-matter-status', 'expected.stderr.txt'));
  assert.equal(normalizeOutput(result.stdout), readExpected('invalid-front-matter-status', 'expected.stdout.txt'));
});

test('builds a source directory without config and preserves markdown passthrough', async () => {
  const tempDir = await makeTempDir();
  const sourceDir = path.join(tempDir, 'docs');
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'index.md'), [
    '---',
    'title: Front Matter Home',
    'description: Home from front matter.',
    '---',
    '',
    'Welcome to the docs. See [Guide](guide.md).',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(sourceDir, 'guide.md'), [
    '# Guide',
    '',
    'See [Custom](custom.md).',
    '',
    '- [x] Built with ZeroPress.',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(sourceDir, 'custom.md'), [
    '---',
    'title: Custom Front Matter Title',
    'description: Custom front matter excerpt.',
    'path: guides/custom-page',
    'status: published',
    'discoverability: delist',
    'featured_image: /images/custom-share.png',
    'unknown_key: ignored',
    'meta:',
    '  source: docs',
    '  featured: true',
    'data:',
    '  stack:',
    '    - ZeroPress',
    '    - Cloudflare',
    '  facts:',
    '    - label: Role',
    '      value: Docs',
    '---',
    '',
    '# Body Heading',
    '',
    'Custom content.',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(sourceDir, 'favicon.ico'), 'icon', 'utf8');
  await fs.writeFile(path.join(sourceDir, 'favicon.svg'), '<svg></svg>', 'utf8');
  await fs.writeFile(path.join(sourceDir, 'favicon.png'), 'png', 'utf8');
  await fs.writeFile(path.join(sourceDir, 'apple-touch-icon.png'), 'apple', 'utf8');
  await fs.writeFile(path.join(sourceDir, 'sitemap.xsl'), '<xsl:stylesheet version="1.0"></xsl:stylesheet>', 'utf8');
  await fs.writeFile(path.join(sourceDir, 'draft.md'), [
    '---',
    'status: draft',
    '---',
    '',
    '# Draft',
    '',
    'Draft content.',
  ].join('\n'), 'utf8');

  await runBuildPages({
    cwd: tempDir,
    source: 'docs',
    destination: '_site',
    theme: 'docs',
    siteUrl: 'https://example.com',
    skipLinkCheck: false,
  });

  const indexHtml = await fs.readFile(path.join(tempDir, '_site', 'index.html'), 'utf8');
  const guideHtml = await fs.readFile(path.join(tempDir, '_site', 'guide.html'), 'utf8');
  const customHtml = await fs.readFile(path.join(tempDir, '_site', 'guides', 'custom-page.html'), 'utf8');
  const previewData = JSON.parse(await fs.readFile(path.join(tempDir, '.zeropress-build-pages', 'preview-data.json'), 'utf8'));
  const buildReport = JSON.parse(await fs.readFile(path.join(tempDir, '.zeropress-build-pages', 'build-report.json'), 'utf8'));
  const homePage = previewData.content.pages.find((page) => page.slug === 'index');
  const customPage = previewData.content.pages.find((page) => page.path === 'guides/custom-page');

  assert.equal(Object.hasOwn(previewData.site, 'robots'), false);
  assert.equal(previewData.site.expose_generator, true);
  assert.equal(buildReport.build_pages_version, JSON.parse(await fs.readFile(path.join(packageDir, 'package.json'), 'utf8')).version);
  assert.equal(buildReport.theme_id, await readBundledThemeId('docs1'));
  assert.match(buildReport.theme_id, /^[a-z0-9][a-z0-9_-]*\.[a-z0-9][a-z0-9_-]*@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  assert.equal(homePage.title, 'Front Matter Home');
  assert.equal(homePage.excerpt, 'Home from front matter.');
  assert.equal(customPage.title, 'Custom Front Matter Title');
  assert.equal(customPage.excerpt, 'Custom front matter excerpt.');
  assert.equal(customPage.path, 'guides/custom-page');
  assert.equal(customPage.featured_image, 'https://example.com/images/custom-share.png');
  assert.equal(customPage.discoverability, 'delist');
  assert.deepEqual(customPage.meta, {
    source: 'docs',
    featured: true,
    source_markdown_url: '/custom.md',
  });
  assert.deepEqual(customPage.data, {
    stack: ['ZeroPress', 'Cloudflare'],
    facts: [
      { label: 'Role', value: 'Docs' },
    ],
  });
  assert.equal(Object.hasOwn(customPage, 'unknown_key'), false);
  assert.doesNotMatch(customPage.content, /title: Custom Front Matter Title|---/);
  assert.equal(previewData.content.pages.some((page) => page.slug === 'draft'), false);
  assert.equal(buildReport.copy_markdown_source, true);
  assert.equal(buildReport.markdown.skipped_files.length, 1);
  assert.match(buildReport.markdown.skipped_files[0].file, /draft\.md$/);
  assert.equal(buildReport.markdown.skipped_files[0].reason, 'front matter status is "draft".');
  assert.match(indexHtml, /<meta name="description" content="Home from front matter\.">/);
  assert.match(indexHtml, /property="og:description" content="Home from front matter\."/);
  assert.match(indexHtml, /<meta name="generator" content="ZeroPress">/);
  assert.match(indexHtml, /<link rel="icon" href="\/favicon\.ico">/);
  assert.match(indexHtml, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/);
  assert.match(indexHtml, /<link rel="icon" href="\/favicon\.png" type="image\/png">/);
  assert.match(indexHtml, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png">/);
  assert.match(indexHtml, /href="\/guide"/);
  assert.match(guideHtml, /href="\/guides\/custom-page"/);
  assert.match(guideHtml, /contains-task-list/);
  assert.match(customHtml, /Body Heading/);
  assert.match(customHtml, /<meta property="og:image" content="https:\/\/example\.com\/images\/custom-share\.png">/);
  assert.match(customHtml, /<meta name="robots" content="noindex">/);
  assert.match(customHtml, /View as Markdown/);
  assert.doesNotMatch(customHtml, /title: Custom Front Matter Title|---/);
  const searchItems = JSON.parse(await fs.readFile(path.join(tempDir, '_site', '_zeropress', 'search.json'), 'utf8'));
  assert.equal(searchItems.some((item) => item.id === 'page:guides-custom-page'), false);
  await fs.access(path.join(tempDir, '_site', '_zeropress', 'search_pagefind.js'));
  await fs.access(path.join(tempDir, '_site', 'guide.md'));
  await fs.access(path.join(tempDir, '_site', 'custom.md'));
  await fs.access(path.join(tempDir, '_site', 'favicon.ico'));
  await fs.access(path.join(tempDir, '_site', 'favicon.svg'));
  await fs.access(path.join(tempDir, '_site', 'favicon.png'));
  await fs.access(path.join(tempDir, '_site', 'apple-touch-icon.png'));
  await fs.access(path.join(tempDir, '_site', 'sitemap.xsl'));
  assert.match(
    await fs.readFile(path.join(tempDir, '_site', 'sitemap.xml'), 'utf8'),
    /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<\?xml-stylesheet type="text\/xsl" href="\/sitemap\.xsl"\?>\n<urlset/,
  );
  await assert.rejects(() => fs.access(path.join(tempDir, '_site', 'feed.xml')));
  await fs.access(path.join(tempDir, '.zeropress-build-pages', 'preview-data.json'));
});

test('uses front page markdown excerpt for front page metadata', async () => {
  const cases = [
    {
      name: 'generated excerpt',
      site: { description: 'Site description stays in the title only.' },
      frontMatter: [],
      body: 'Generated page excerpt.',
      expectedTitle: 'Documentation - Site description stays in the title only.',
      expectedSiteDescription: 'Site description stays in the title only.',
      expectedPageExcerpt: 'Generated page excerpt.',
      expectedMetaDescription: 'Generated page excerpt.',
    },
    {
      name: 'front matter description override',
      site: { title: 'foo' },
      frontMatter: ['description: Front matter description.'],
      body: 'Generated page excerpt should not be used.',
      expectedTitle: 'foo',
      expectedSiteDescription: '',
      expectedPageExcerpt: 'Front matter description.',
      expectedMetaDescription: 'Front matter description.',
    },
    {
      name: 'empty front matter description',
      site: { description: 'bar' },
      frontMatter: ['description: ""'],
      body: 'Generated page excerpt should be suppressed.',
      expectedTitle: 'Documentation - bar',
      expectedSiteDescription: 'bar',
      expectedPageExcerpt: '',
      expectedMetaDescription: '',
    },
  ];

  for (const testCase of cases) {
    const tempDir = await makeTempDir();
    const sourceDir = path.join(tempDir, 'docs');
    await fs.mkdir(path.join(sourceDir, '.zeropress'), { recursive: true });
    const markdownLines = testCase.frontMatter.length > 0
      ? [
          '---',
          ...testCase.frontMatter,
          '---',
          '',
          '# Page Heading',
          '',
          testCase.body,
        ]
      : [
          '# Page Heading',
          '',
          testCase.body,
        ];
    await fs.writeFile(path.join(sourceDir, 'index.md'), markdownLines.join('\n'), 'utf8');

    if (testCase.site !== undefined) {
      await fs.writeFile(path.join(sourceDir, '.zeropress', 'config.json'), JSON.stringify({
        version: '1.0',
        site: testCase.site,
      }, null, 2), 'utf8');
    }

    await runBuildPages({
      cwd: tempDir,
      source: 'docs',
      destination: '_site',
      theme: 'docs',
      themePath: path.join(packageDir, 'themes', 'docs1'),
      skipLinkCheck: true,
    });

    const indexHtml = await fs.readFile(path.join(tempDir, '_site', 'index.html'), 'utf8');
    const previewData = JSON.parse(await fs.readFile(path.join(tempDir, '.zeropress-build-pages', 'preview-data.json'), 'utf8'));
    const frontPage = previewData.content.pages.find((page) => page.slug === 'index');

    assert.equal(previewData.site.description, testCase.expectedSiteDescription);
    assert.equal(frontPage.excerpt, testCase.expectedPageExcerpt);
    assert.match(indexHtml, new RegExp(`<title>${escapeRegExp(testCase.expectedTitle)}</title>`));
    assert.match(indexHtml, new RegExp(`property="og:title" content="${escapeRegExp(testCase.expectedTitle)}"`));
    if (testCase.expectedMetaDescription) {
      assert.match(indexHtml, new RegExp(`<meta name="description" content="${escapeRegExp(testCase.expectedMetaDescription)}">`));
      assert.match(indexHtml, new RegExp(`property="og:description" content="${escapeRegExp(testCase.expectedMetaDescription)}"`));
    } else {
      assert.doesNotMatch(indexHtml, /<meta name="description"/);
      assert.doesNotMatch(indexHtml, /property="og:description"/);
    }
  }
});

test('rewrites source-relative markdown links with explicit html output when configured', async () => {
  const tempDir = await makeTempDir();
  const sourceDir = path.join(tempDir, 'docs');
  await fs.mkdir(path.join(sourceDir, '.zeropress'), { recursive: true });
  await fs.mkdir(path.join(sourceDir, 'section'), { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'index.md'), [
    '# Home',
    '',
    '[Guide](guide.md)',
    '[Guide title](guide.md "Guide title")',
    '[Guide angle](<guide.md> \'Angle title\')',
    '[Nested](section/index.md)',
    '[Home](index.md)',
    '[Guide hash](guide.md#part)',
    '[Guide query](guide.md?view=full)',
    '`[Code](guide.md)`',
    '\\[Escaped](guide.md)',
    '',
    '    [Indented code](guide.md)',
    '',
    '> ```md',
    '> [Quoted code](guide.md)',
    '> ```',
    '[External](https://example.com/guide.md)',
    '[Root relative](/guide.md)',
    '[Asset](file.pdf)',
    '[Local hash](#local)',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(sourceDir, 'guide.md'), [
    '# Guide',
    '',
    'Guide content.',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(sourceDir, 'section', 'index.md'), [
    '# Nested',
    '',
    'Nested content.',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(sourceDir, '.zeropress', 'config.json'), JSON.stringify({
    version: '1.0',
    markdown: {
      link_output: 'html',
    },
    front_page: {
      type: 'markdown',
    },
  }, null, 2), 'utf8');

  await runBuildPages({
    cwd: tempDir,
    source: 'docs',
    destination: '_site',
    theme: 'docs',
    themePath: path.join(packageDir, 'themes', 'docs1'),
    skipLinkCheck: true,
  });

  const indexHtml = await fs.readFile(path.join(tempDir, '_site', 'index.html'), 'utf8');
  const resolvedConfig = JSON.parse(await fs.readFile(path.join(tempDir, '.zeropress-build-pages', 'build-pages-config.json'), 'utf8'));
  const previewData = JSON.parse(await fs.readFile(path.join(tempDir, '.zeropress-build-pages', 'preview-data.json'), 'utf8'));
  const indexPage = previewData.content.pages.find((page) => page.slug === 'index');

  assert.deepEqual(resolvedConfig.markdown, {
    updated_at: 'none',
    link_output: 'html',
  });
  assert.match(indexHtml, /href="\/guide\.html"/);
  assert.match(indexHtml, /href="\/guide\.html" title="Guide title">Guide title<\/a>/);
  assert.match(indexHtml, /href="\/guide\.html" title="Angle title">Guide angle<\/a>/);
  assert.match(indexHtml, /href="\/section\/index\.html"/);
  assert.match(indexHtml, /href="\/index\.html"/);
  assert.match(indexHtml, /href="\/guide\.html#part"/);
  assert.match(indexHtml, /href="\/guide\.html\?view=full"/);
  assert.match(indexHtml, /href="https:\/\/example\.com\/guide\.md"/);
  assert.match(indexHtml, /href="\/guide\.md"/);
  assert.match(indexHtml, /href="file\.pdf"/);
  assert.match(indexHtml, /href="#local"/);
  assert.match(indexHtml, /<code>\[Code\]\(guide\.md\)<\/code>/);
  assert.match(indexPage.content, /\[Guide title\]\(\/guide\.html "Guide title"\)/);
  assert.match(indexPage.content, /\[Guide angle\]\(<\/guide\.html> 'Angle title'\)/);
  assert.match(indexPage.content, /`\[Code\]\(guide\.md\)`/);
  assert.match(indexPage.content, /\\\[Escaped\]\(guide\.md\)/);
  assert.match(indexPage.content, /^ {4}\[Indented code\]\(guide\.md\)$/m);
  assert.match(indexPage.content, /^> \[Quoted code\]\(guide\.md\)$/m);
});

test('rewrites source-relative public asset links when the target exists in public-dir', async () => {
  const tempDir = await makeTempDir();
  const sourceDir = path.join(tempDir, 'docs');
  const publicDir = path.join(tempDir, 'public');
  await fs.mkdir(path.join(sourceDir, 'markdown', 'features'), { recursive: true });
  await fs.mkdir(path.join(publicDir, 'files'), { recursive: true });
  await fs.mkdir(path.join(publicDir, 'images'), { recursive: true });
  await fs.mkdir(path.join(publicDir, 'videos'), { recursive: true });
  await fs.mkdir(path.join(publicDir, 'audio'), { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'index.md'), '# Home\n\nHome.', 'utf8');
  await fs.writeFile(path.join(sourceDir, 'guide.md'), '# Guide\n\nGuide.', 'utf8');
  await fs.writeFile(path.join(sourceDir, 'markdown', 'features', 'index.md'), [
    '---',
    'featured_image: ../../../public/images/poster.png?card=1#share',
    '---',
    '',
    '# Features',
    '',
    '![Logo](../../../public/favicon.png)',
    '[PDF](../../../public/files/doc.pdf?download=1#page)',
    '[Missing](../../../public/missing.png)',
    '[Outside](../../../outside.png)',
    '[Root](/root-logo.png)',
    '[External](https://example.com/favicon.png)',
    '[Hash](#images)',
    '[Guide](../../guide.md#part)',
    '<img src="../../../public/favicon.svg#icon" alt="Icon">',
    '<video poster="../../../public/images/poster.png" src="../../../public/videos/demo.mp4"></video>',
    '<audio><source src="../../../public/audio/demo.mp3" type="audio/mpeg"></audio>',
    '<track src="../../../public/files/captions.vtt" kind="captions">',
    '<source srcset="../../../public/images/small.png 1x, ../../../public/images/large.png 2x">',
    '`<img src="../../../public/favicon.svg">`',
    '!\\[Escaped logo](../../../public/favicon.png)',
    '',
    '```md',
    '![Code](../../../public/code-only.png)',
    '```',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(publicDir, 'favicon.png'), 'png', 'utf8');
  await fs.writeFile(path.join(publicDir, 'favicon.svg'), '<svg></svg>', 'utf8');
  await fs.writeFile(path.join(publicDir, 'files', 'doc.pdf'), 'pdf', 'utf8');
  await fs.writeFile(path.join(publicDir, 'files', 'captions.vtt'), 'WEBVTT', 'utf8');
  await fs.writeFile(path.join(publicDir, 'images', 'poster.png'), 'poster', 'utf8');
  await fs.writeFile(path.join(publicDir, 'images', 'small.png'), 'small', 'utf8');
  await fs.writeFile(path.join(publicDir, 'images', 'large.png'), 'large', 'utf8');
  await fs.writeFile(path.join(publicDir, 'videos', 'demo.mp4'), 'video', 'utf8');
  await fs.writeFile(path.join(publicDir, 'audio', 'demo.mp3'), 'audio', 'utf8');

  await runBuildPages({
    cwd: tempDir,
    source: 'docs',
    publicDir: 'public',
    destination: '_site',
    theme: 'docs',
    themePath: path.join(packageDir, 'themes', 'docs1'),
    siteUrl: 'https://example.com',
    skipLinkCheck: true,
  });

  const previewData = JSON.parse(await fs.readFile(path.join(tempDir, '.zeropress-build-pages', 'preview-data.json'), 'utf8'));
  const featuresPage = previewData.content.pages.find((page) => page.path === 'markdown/features/index');

  assert.equal(featuresPage.featured_image, 'https://example.com/images/poster.png?card=1#share');
  assert.match(featuresPage.content, /!\[Logo\]\(\/favicon\.png\)/);
  assert.match(featuresPage.content, /\[PDF\]\(\/files\/doc\.pdf\?download=1#page\)/);
  assert.match(featuresPage.content, /\[Missing\]\(\.\.\/\.\.\/\.\.\/public\/missing\.png\)/);
  assert.match(featuresPage.content, /\[Outside\]\(\.\.\/\.\.\/\.\.\/outside\.png\)/);
  assert.match(featuresPage.content, /\[Root\]\(\/root-logo\.png\)/);
  assert.match(featuresPage.content, /\[External\]\(https:\/\/example\.com\/favicon\.png\)/);
  assert.match(featuresPage.content, /\[Hash\]\(#images\)/);
  assert.match(featuresPage.content, /\[Guide\]\(\/guide#part\)/);
  assert.match(featuresPage.content, /<img src="\/favicon\.svg#icon" alt="Icon">/);
  assert.match(featuresPage.content, /<video poster="\/images\/poster\.png" src="\/videos\/demo\.mp4"><\/video>/);
  assert.match(featuresPage.content, /<audio><source src="\/audio\/demo\.mp3" type="audio\/mpeg"><\/audio>/);
  assert.match(featuresPage.content, /<track src="\/files\/captions\.vtt" kind="captions">/);
  assert.match(featuresPage.content, /<source srcset="\/images\/small\.png 1x, \/images\/large\.png 2x">/);
  assert.match(featuresPage.content, /`<img src="\.\.\/\.\.\/\.\.\/public\/favicon\.svg">`/);
  assert.match(featuresPage.content, /!\\\[Escaped logo\]\(\.\.\/\.\.\/\.\.\/public\/favicon\.png\)/);
  assert.match(featuresPage.content, /!\[Code\]\(\.\.\/\.\.\/\.\.\/public\/code-only\.png\)/);

  const featuresHtml = await fs.readFile(path.join(tempDir, '_site', 'markdown', 'features', 'index.html'), 'utf8');
  assert.match(featuresHtml, /<meta property="og:image" content="https:\/\/example\.com\/images\/poster\.png\?card=1#share">/);
  assert.match(featuresHtml, /<video poster="\/images\/poster\.png" src="\/videos\/demo\.mp4"><\/video>/);
  assert.match(featuresHtml, /<audio><source src="\/audio\/demo\.mp3" type="audio\/mpeg" \/><\/audio>/);
  assert.match(featuresHtml, /<track src="\/files\/captions\.vtt" kind="captions" \/>/);
});

test('builds with a separated public directory', async () => {
  const tempDir = await makeTempDir();
  const sourceDir = path.join(tempDir, 'docs');
  const publicDir = path.join(tempDir, 'public');
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.mkdir(path.join(publicDir, 'assets'), { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'index.md'), '# Home\n\nSee [Guide](guide.md).', 'utf8');
  await fs.writeFile(path.join(sourceDir, 'guide.md'), '# Guide\n\nGuide content.', 'utf8');
  await fs.writeFile(path.join(publicDir, 'assets', 'logo.txt'), 'logo', 'utf8');
  await fs.writeFile(path.join(publicDir, 'favicon.svg'), '<svg></svg>', 'utf8');
  await fs.writeFile(path.join(publicDir, 'robots.txt'), 'User-agent: *\nDisallow: /tmp\n', 'utf8');
  await fs.writeFile(path.join(publicDir, 'sitemap.xsl'), '<xsl:stylesheet version="1.0"></xsl:stylesheet>', 'utf8');
  await fs.writeFile(path.join(publicDir, 'README.MD'), '# Public Markdown\n\nPassthrough.', 'utf8');

  await runBuildPages({
    cwd: tempDir,
    source: 'docs',
    publicDir: 'public',
    destination: '_site',
    theme: 'docs',
    siteUrl: 'https://example.com',
    skipLinkCheck: true,
  });

  const indexHtml = await fs.readFile(path.join(tempDir, '_site', 'index.html'), 'utf8');
  const robotsTxt = await fs.readFile(path.join(tempDir, '_site', 'robots.txt'), 'utf8');
  const previewData = JSON.parse(await fs.readFile(path.join(tempDir, '.zeropress-build-pages', 'preview-data.json'), 'utf8'));
  const buildReport = JSON.parse(await fs.readFile(path.join(tempDir, '.zeropress-build-pages', 'build-report.json'), 'utf8'));

  assert.match(buildReport.source_dir, /docs$/);
  assert.match(buildReport.public_dir, /public$/);
  assert.equal(buildReport.theme_id, await readBundledThemeId('docs1'));
  assert.equal(previewData.content.pages.find((page) => page.slug === 'guide').meta.source_markdown_url, '/guide.md');
  assert.match(indexHtml, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/);
  assert.equal(robotsTxt, 'User-agent: *\nDisallow: /tmp\n');
  await fs.access(path.join(tempDir, '_site', 'assets', 'logo.txt'));
  await fs.access(path.join(tempDir, '_site', 'sitemap.xsl'));
  await fs.access(path.join(tempDir, '_site', 'README.MD'));
  await fs.access(path.join(tempDir, '_site', 'index.md'));
  await fs.access(path.join(tempDir, '_site', 'guide.md'));
});

test('rejects a staged public file that owns a generated html-extension output path', async () => {
  const tempDir = await makeTempDir();
  const sourceDir = path.join(tempDir, 'docs');
  const publicDir = path.join(tempDir, 'public');
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.mkdir(publicDir, { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'index.md'), '# Home\n', 'utf8');
  await fs.writeFile(path.join(sourceDir, 'guide.md'), '# Guide\n', 'utf8');
  await fs.writeFile(path.join(publicDir, 'guide.html'), '<h1>Public guide</h1>', 'utf8');

  await assert.rejects(
    () => runBuildPages({
      cwd: tempDir,
      source: 'docs',
      publicDir: 'public',
      destination: '_site',
      theme: 'plain',
      skipLinkCheck: true,
    }),
    /Duplicate (?:public URL|output path) detected: \/?guide\.html/,
  );
  await assert.rejects(fs.access(path.join(tempDir, '_site')), { code: 'ENOENT' });
});

test('rejects a staged public index file whose parent clean URL owns a generated route', async () => {
  const tempDir = await makeTempDir();
  const sourceDir = path.join(tempDir, 'docs');
  const publicDir = path.join(tempDir, 'public');
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.mkdir(path.join(publicDir, 'guide'), { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'index.md'), '# Home\n', 'utf8');
  await fs.writeFile(path.join(sourceDir, 'guide.md'), '# Guide\n', 'utf8');
  await fs.writeFile(path.join(publicDir, 'guide', 'index.html'), '<h1>Public guide</h1>', 'utf8');

  await assert.rejects(
    () => runBuildPages({
      cwd: tempDir,
      source: 'docs',
      publicDir: 'public',
      destination: '_site',
      theme: 'plain',
      skipLinkCheck: true,
    }),
    /Duplicate public URL detected: \/guide\//,
  );
  await assert.rejects(fs.access(path.join(tempDir, '_site')), { code: 'ENOENT' });
});

test('can build without copying original markdown source', async () => {
  const tempDir = await makeTempDir();
  const sourceDir = path.join(tempDir, 'docs');
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'index.md'), '# Home\n\nSee [Guide](guide.md).', 'utf8');
  await fs.writeFile(path.join(sourceDir, 'guide.md'), '# Guide\n\nPrivate source.', 'utf8');
  await fs.writeFile(path.join(sourceDir, 'README.MD'), '# Uppercase Markdown\n\nPublic passthrough only.', 'utf8');

  await runBuildPages({
    cwd: tempDir,
    source: 'docs',
    destination: '_site',
    theme: 'docs',
    skipLinkCheck: true,
    copyMarkdownSource: false,
  });

  const guideHtml = await fs.readFile(path.join(tempDir, '_site', 'guide.html'), 'utf8');
  const previewData = JSON.parse(await fs.readFile(path.join(tempDir, '.zeropress-build-pages', 'preview-data.json'), 'utf8'));
  const buildReport = JSON.parse(await fs.readFile(path.join(tempDir, '.zeropress-build-pages', 'build-report.json'), 'utf8'));
  const resolvedConfig = JSON.parse(await fs.readFile(path.join(tempDir, '.zeropress-build-pages', 'build-pages-config.json'), 'utf8'));
  const guidePage = previewData.content.pages.find((page) => page.slug === 'guide');

  assert.equal(buildReport.copy_markdown_source, false);
  assert.equal(Object.hasOwn(resolvedConfig, 'copy_markdown_source'), false);
  assert.equal(Object.hasOwn(guidePage.meta, 'source_markdown_url'), false);
  assert.doesNotMatch(guideHtml, /View this page as Markdown/);
  assert.equal(await pathExists(path.join(tempDir, '_site', 'index.md')), false);
  assert.equal(await pathExists(path.join(tempDir, '_site', 'guide.md')), false);
  assert.equal(await pathExists(path.join(tempDir, '_site', 'README.MD')), false);
  await fs.access(path.join(tempDir, '_site', 'index.html'));
  await fs.access(path.join(tempDir, '_site', 'guide.html'));
});

test('does not copy source or public markdown when markdown source copy is disabled', async () => {
  const tempDir = await makeTempDir();
  const sourceDir = path.join(tempDir, 'docs');
  const publicDir = path.join(tempDir, 'public');
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.mkdir(publicDir, { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'index.md'), '# Home\n\nPrivate source.', 'utf8');
  await fs.writeFile(path.join(publicDir, 'README.MD'), '# Public Markdown\n\nAlso private.', 'utf8');
  await fs.writeFile(path.join(publicDir, 'asset.txt'), 'asset', 'utf8');

  await runBuildPages({
    cwd: tempDir,
    source: 'docs',
    publicDir: 'public',
    destination: '_site',
    theme: 'docs',
    skipLinkCheck: true,
    copyMarkdownSource: false,
  });

  await fs.access(path.join(tempDir, '_site', 'index.html'));
  await fs.access(path.join(tempDir, '_site', 'asset.txt'));
  assert.equal(await pathExists(path.join(tempDir, '_site', 'index.md')), false);
  assert.equal(await pathExists(path.join(tempDir, '_site', 'README.MD')), false);
});

test('excludes nested public directory from markdown discovery', async () => {
  const tempDir = await makeTempDir();
  const sourceDir = path.join(tempDir, 'docs');
  await fs.mkdir(path.join(sourceDir, 'public'), { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'index.md'), '# Home\n\nNested public root.', 'utf8');
  await fs.writeFile(path.join(sourceDir, 'public', 'asset.md'), '# Asset Markdown\n\nPassthrough only.', 'utf8');

  await runBuildPages({
    cwd: tempDir,
    source: 'docs',
    publicDir: 'docs/public',
    destination: '_site',
    theme: 'docs',
    skipLinkCheck: true,
  });

  const previewData = JSON.parse(await fs.readFile(path.join(tempDir, '.zeropress-build-pages', 'preview-data.json'), 'utf8'));
  assert.equal(previewData.content.pages.some((page) => page.slug === 'asset'), false);
  await fs.access(path.join(tempDir, '_site', 'asset.md'));
  assert.equal(await pathExists(path.join(tempDir, '_site', 'asset.html')), false);
});

test('uses source robots.txt before generated fallback robots', async () => {
  const tempDir = await makeTempDir();
  const sourceDir = path.join(tempDir, 'docs');
  await fs.mkdir(path.join(sourceDir, '.zeropress'), { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'index.md'), '# Home\n\nRobots test.', 'utf8');
  await fs.writeFile(
    path.join(sourceDir, 'robots.txt'),
    'User-agent: *\nDisallow: /\n\nUser-agent: Cloudflare-AI-Search\nAllow: /\n',
    'utf8',
  );
  await fs.writeFile(path.join(sourceDir, '.zeropress', 'config.json'), JSON.stringify({
    version: '1.0',
    site: {
      robots: { allow_indexing: true },
    },
  }), 'utf8');

  await runBuildPages({
    cwd: tempDir,
    source: 'docs',
    destination: '_site',
    theme: 'docs',
    skipLinkCheck: true,
  });

  const robotsTxt = await fs.readFile(path.join(tempDir, '_site', 'robots.txt'), 'utf8');
  assert.equal(robotsTxt, 'User-agent: *\nDisallow: /\n\nUser-agent: Cloudflare-AI-Search\nAllow: /\n');
});

test('rejects repository root source before touching internal working files', async () => {
  const tempDir = await makeTempDir();
  await fs.mkdir(path.join(tempDir, '.zeropress'), { recursive: true });
  await fs.writeFile(path.join(tempDir, '.zeropress', 'config.json'), '{"version":"1.0"}', 'utf8');
  await fs.writeFile(path.join(tempDir, 'index.md'), '# Home\n\nRoot source should be rejected.', 'utf8');

  await assert.rejects(
    runBuildPages({
      cwd: tempDir,
      source: '.',
      destination: '_site',
      theme: 'docs',
      skipLinkCheck: true,
    }),
    /Source directory must be a dedicated content directory/,
  );

  await fs.access(path.join(tempDir, '.zeropress', 'config.json'));
});

test('rejects source, destination, and theme overlap with build-pages working paths', async () => {
  const tempDir = await makeTempDir();
  await fs.mkdir(path.join(tempDir, 'docs'), { recursive: true });
  await fs.writeFile(path.join(tempDir, 'docs', 'index.md'), '# Home\n\nOverlap checks.', 'utf8');
  await fs.mkdir(path.join(tempDir, '.zeropress-build-pages', 'source'), { recursive: true });
  await fs.mkdir(path.join(tempDir, 'custom-theme'), { recursive: true });

  await assert.rejects(
    runBuildPages({
      cwd: tempDir,
      source: '.zeropress-build-pages/source',
      destination: '_site',
      theme: 'docs',
      skipLinkCheck: true,
    }),
    /Source directory must not overlap the internal \.zeropress-build-pages working directory/,
  );

  await assert.rejects(
    runBuildPages({
      cwd: tempDir,
      source: 'docs',
      destination: '.zeropress-build-pages/site',
      theme: 'docs',
      skipLinkCheck: true,
    }),
    /Destination directory must not overlap the internal \.zeropress-build-pages working directory/,
  );

  await assert.rejects(
    runBuildPages({
      cwd: tempDir,
      source: 'docs',
      destination: '_site',
      themePath: '.zeropress-build-pages/theme',
      skipLinkCheck: true,
    }),
    /Theme directory must not overlap the internal \.zeropress-build-pages working directory/,
  );

  await assert.rejects(
    runBuildPages({
      cwd: tempDir,
      source: 'docs',
      destination: 'docs/_site',
      theme: 'docs',
      skipLinkCheck: true,
    }),
    /Source directory must not overlap the destination directory/,
  );

  await assert.rejects(
    runBuildPages({
      cwd: tempDir,
      source: 'docs',
      destination: '_site',
      themePath: 'docs/theme',
      skipLinkCheck: true,
    }),
    /Source directory must not overlap the theme directory/,
  );

  await assert.rejects(
    runBuildPages({
      cwd: tempDir,
      source: 'docs',
      publicDir: '.zeropress-build-pages/public',
      destination: '_site',
      theme: 'docs',
      skipLinkCheck: true,
    }),
    /Public directory must not overlap the internal \.zeropress-build-pages working directory/,
  );

  await assert.rejects(
    runBuildPages({
      cwd: tempDir,
      source: 'docs',
      publicDir: '_site/public',
      destination: '_site',
      theme: 'docs',
      skipLinkCheck: true,
    }),
    /Public directory must not overlap the destination directory/,
  );

  await assert.rejects(
    runBuildPages({
      cwd: tempDir,
      source: 'docs',
      publicDir: 'custom-theme/public',
      destination: '_site',
      themePath: 'custom-theme',
      skipLinkCheck: true,
    }),
    /Public directory must not overlap the theme directory/,
  );
});

test('rejects invalid explicit public directory paths', async () => {
  const tempDir = await makeTempDir();
  await fs.mkdir(path.join(tempDir, 'docs'), { recursive: true });
  await fs.mkdir(path.join(tempDir, 'public'), { recursive: true });
  await fs.mkdir(path.join(tempDir, 'content'), { recursive: true });
  await fs.writeFile(path.join(tempDir, 'docs', 'index.md'), '# Home\n\nPublic path checks.', 'utf8');
  await fs.writeFile(path.join(tempDir, 'public-file'), 'not a directory', 'utf8');
  await fs.symlink(path.join(tempDir, 'public'), path.join(tempDir, 'public-link'));

  await assert.rejects(
    runBuildPages({
      cwd: tempDir,
      source: 'docs',
      publicDir: 'missing-public',
      destination: '_site',
      theme: 'docs',
      skipLinkCheck: true,
    }),
    /Public directory not found/,
  );

  await assert.rejects(
    runBuildPages({
      cwd: tempDir,
      source: 'docs',
      publicDir: 'public-file',
      destination: '_site',
      theme: 'docs',
      skipLinkCheck: true,
    }),
    /Public path is not a directory/,
  );

  await assert.rejects(
    runBuildPages({
      cwd: tempDir,
      source: 'docs',
      publicDir: 'public-link',
      destination: '_site',
      theme: 'docs',
      skipLinkCheck: true,
    }),
    /Public directory must not be a symbolic link/,
  );

  await assert.rejects(
    runBuildPages({
      cwd: tempDir,
      source: 'docs',
      publicDir: '.',
      destination: '_site',
      theme: 'docs',
      skipLinkCheck: true,
    }),
    /Public directory must be a dedicated asset directory/,
  );

  await assert.rejects(
    runBuildPages({
      cwd: tempDir,
      source: 'content/docs',
      publicDir: 'content',
      destination: '_site',
      theme: 'docs',
      skipLinkCheck: true,
    }),
    /Source directory must not be inside the public directory/,
  );
});

test('rejects destination path when it is not a directory', async () => {
  const tempDir = await makeTempDir();
  await fs.mkdir(path.join(tempDir, 'docs'), { recursive: true });
  await fs.writeFile(path.join(tempDir, 'docs', 'index.md'), '# Home\n\nDestination file check.', 'utf8');
  await fs.writeFile(path.join(tempDir, '_site'), 'not a directory', 'utf8');

  await assert.rejects(
    runBuildPages({
      cwd: tempDir,
      source: 'docs',
      destination: '_site',
      theme: 'docs',
      skipLinkCheck: true,
    }),
    /Destination path is not a directory/,
  );

  assert.equal(await fs.readFile(path.join(tempDir, '_site'), 'utf8'), 'not a directory');
});

test('rejects missing theme path before prebuild writes internal files', async () => {
  const tempDir = await makeTempDir();
  await fs.mkdir(path.join(tempDir, 'docs'), { recursive: true });
  await fs.writeFile(path.join(tempDir, 'docs', 'index.md'), '# Home\n\nMissing theme check.', 'utf8');

  await assert.rejects(
    runBuildPages({
      cwd: tempDir,
      source: 'docs',
      destination: '_site',
      themePath: 'missing-theme',
      skipLinkCheck: true,
    }),
    /Theme directory not found/,
  );

  await assert.rejects(
    fs.access(path.join(tempDir, '.zeropress-build-pages')),
    /ENOENT/,
  );
});

test('builds with config, custom theme path, and source inside a subdirectory', async () => {
  const tempDir = await makeTempDir();
  const sourceDir = path.join(tempDir, 'docs');
  await fs.mkdir(path.join(sourceDir, '.zeropress'), { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'index.md'), '# Home\n\nConfigured home.', 'utf8');
  await fs.writeFile(path.join(sourceDir, 'topic.md'), '# Topic\n\nContent.', 'utf8');
  await fs.writeFile(path.join(sourceDir, '.zeropress', 'head-end.html'), ' \n<meta name="test-head" content="ok">\n ', 'utf8');
  await fs.writeFile(path.join(sourceDir, '.zeropress', 'config.json'), JSON.stringify({
    version: '1.0',
    site: {
      title: 'Configured Docs',
      description: 'A configured docs site.',
      url: 'https://config.example',
      logo: {
        src: '/logo.svg',
        alt: 'Configured Docs logo',
      },
      locale: 'ko-KR',
      expose_generator: false,
      search: false,
      robots: { allow_indexing: false },
      footer: {
        copyright_text: 'Copyright 2026 Example Corp.',
        attribution: false,
      },
      meta: {
        issue: 'Spring 2026',
        show_sponsor_banner: true,
        empty_value: null,
      },
    },
    front_page: {
      type: 'markdown',
    },
    custom_html: {
      head_end: {
        file: '.zeropress/head-end.html',
      },
    },
    menus: {
      primary: {
        name: 'Primary Menu',
        items: [
          { title: 'Home', url: '/' },
          {
            title: 'Topic',
            url: '/topic',
            meta: {
              icon: 'book-open',
              badge: 'New',
              featured: true,
            },
          },
          {
            title: 'External Docs',
            url: 'https://docs.example.com/',
            target: '_blank',
          },
        ],
      },
    },
    collections: {
      docs: {
        title: 'Docs Order',
        items: [
          'index.md',
          'topic.md',
        ],
      },
    },
  }, null, 2), 'utf8');

  await runBuildPages({
    cwd: tempDir,
    source: 'docs',
    destination: '_site',
    theme: 'docs',
    themePath: path.join(packageDir, 'themes', 'docs1'),
    siteUrl: 'https://override.example',
    skipLinkCheck: true,
  });

  const indexHtml = await fs.readFile(path.join(tempDir, '_site', 'index.html'), 'utf8');
  const robotsTxt = await fs.readFile(path.join(tempDir, '_site', 'robots.txt'), 'utf8');
  assert.match(indexHtml, /Configured Docs/);
  assert.match(indexHtml, /Copyright 2026 Example Corp\./);
  assert.doesNotMatch(indexHtml, /Published with/);
  assert.doesNotMatch(indexHtml, /<meta name="generator" content="ZeroPress">/);
  assert.equal(robotsTxt.trim(), 'User-agent: *\nDisallow: /');
  const previewData = JSON.parse(await fs.readFile(path.join(tempDir, '.zeropress-build-pages', 'preview-data.json'), 'utf8'));
  assert.equal(previewData.$schema, 'https://schemas.zeropress.dev/preview-data/v0.7/schema.json');
  assert.equal(previewData.version, '0.7');
  assert.deepEqual(previewData.custom_html, {
    head_end: ' \n<meta name="test-head" content="ok">\n ',
  });
  assert.deepEqual(previewData.site.footer, {
    copyright_text: 'Copyright 2026 Example Corp.',
    attribution: false,
  });
  assert.equal(previewData.site.url, 'https://override.example');
  assert.equal(previewData.site.media_origin, '');
  assert.equal(previewData.site.locale, 'ko-KR');
  assert.equal(previewData.site.posts_per_page, 10);
  assert.equal(previewData.site.date_style, 'medium');
  assert.equal(previewData.site.time_style, 'none');
  assert.equal(previewData.site.timezone, 'UTC');
  assert.equal(previewData.site.expose_generator, false);
  assert.deepEqual(previewData.site.search, { enabled: false });
  assert.deepEqual(previewData.site.robots, { allow_indexing: false });
  assert.deepEqual(previewData.site.logo, {
    src: '/logo.svg',
    alt: 'Configured Docs logo',
  });
  assert.deepEqual(previewData.site.meta, {
    issue: 'Spring 2026',
    show_sponsor_banner: true,
    empty_value: null,
  });
  assert.deepEqual(previewData.site.permalinks, {
    output_style: 'html-extension',
    posts: '/posts/:slug/',
    pages: '/:slug/',
    categories: '/categories/:slug/',
    tags: '/tags/:slug/',
  });
  assert.equal(Object.hasOwn(previewData.site, 'comments'), false);
  const resolvedConfig = JSON.parse(await fs.readFile(path.join(tempDir, '.zeropress-build-pages', 'build-pages-config.json'), 'utf8'));
  assert.equal(resolvedConfig.$schema, 'https://schemas.zeropress.dev/build-pages-config/v1.0/schema.json');
  assert.equal(resolvedConfig.version, '1.0');
  assert.deepEqual(resolvedConfig.markdown, {
    updated_at: 'none',
    link_output: 'clean',
  });
  assert.deepEqual(resolvedConfig.front_page, {
    type: 'markdown',
    file: 'index.md',
  });
  assert.deepEqual(resolvedConfig.custom_html, {
    head_end: {
      file: '.zeropress/head-end.html',
    },
  });
  assert.deepEqual(resolvedConfig.collections, {
    docs: {
      title: 'Docs Order',
      items: [
        'index.md',
        'topic.md',
      ],
    },
  });
  assert.deepEqual(previewData.collections, {
    docs: {
      title: 'Docs Order',
      items: [
        { type: 'page', path: 'index' },
        { type: 'page', path: 'topic' },
      ],
    },
  });
  assert.deepEqual(resolvedConfig.site, {
    title: 'Configured Docs',
    description: 'A configured docs site.',
    url: 'https://override.example',
    logo: {
      src: '/logo.svg',
      alt: 'Configured Docs logo',
    },
    locale: 'ko-KR',
    expose_generator: false,
    search: false,
    robots: { allow_indexing: false },
    footer: {
      copyright_text: 'Copyright 2026 Example Corp.',
      attribution: false,
    },
    meta: {
      issue: 'Spring 2026',
      show_sponsor_banner: true,
      empty_value: null,
    },
  });
  await assert.rejects(
    () => fs.access(path.join(tempDir, '_site', '_zeropress', 'search.json')),
    /ENOENT/,
  );
  await assert.rejects(
    () => fs.access(path.join(tempDir, '_site', '_zeropress', 'search_pagefind.js')),
    /ENOENT/,
  );
  assert.doesNotMatch(indexHtml, /data-site-search/);
  for (const key of ['media_origin', 'posts_per_page', 'date_style', 'time_style', 'timezone', 'permalinks']) {
    assert.equal(Object.hasOwn(resolvedConfig.site, key), false);
  }
  assert.deepEqual(resolvedConfig.menus.primary.items[1], {
    title: 'Topic',
    url: '/topic',
    target: '_self',
    meta: {
      icon: 'book-open',
      badge: 'New',
      featured: true,
    },
    children: [],
  });
  assert.deepEqual(previewData.menus.primary.items[1].meta, {
    icon: 'book-open',
    badge: 'New',
    featured: true,
  });
  assert.deepEqual(resolvedConfig.menus.primary.items[2], {
    title: 'External Docs',
    url: 'https://docs.example.com/',
    target: '_blank',
    children: [],
  });
  assert.deepEqual(previewData.menus.primary.items[2], resolvedConfig.menus.primary.items[2]);
  await fs.access(path.join(tempDir, '_site', 'topic.html'));
  await fs.access(path.join(tempDir, '_site', 'topic.md'));
});

test('uses effective paths while allowing duplicate Page leaf slugs in front-page and collection references', async () => {
  const tempDir = await makeTempDir();
  const sourceDir = path.join(tempDir, 'docs');
  await fs.mkdir(path.join(sourceDir, '.zeropress'), { recursive: true });
  await fs.mkdir(path.join(sourceDir, 'manual'), { recursive: true });
  await fs.mkdir(path.join(sourceDir, 'reference'), { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'manual', 'guide.md'), '# Manual Guide\n', 'utf8');
  await fs.writeFile(path.join(sourceDir, 'reference', 'guide.md'), '# Reference Guide\n', 'utf8');
  await fs.writeFile(path.join(sourceDir, '.zeropress', 'config.json'), JSON.stringify({
    version: '1.0',
    front_page: {
      type: 'markdown',
      file: 'reference/guide.md',
    },
    collections: {
      guides: {
        items: ['manual/guide.md', 'reference/guide.md'],
      },
    },
  }, null, 2), 'utf8');

  await runBuildPages({
    cwd: tempDir,
    source: 'docs',
    destination: '_site',
    theme: 'plain',
    skipLinkCheck: true,
  });

  const previewData = JSON.parse(await fs.readFile(
    path.join(tempDir, '.zeropress-build-pages', 'preview-data.json'),
    'utf8',
  ));
  assert.deepEqual(
    previewData.content.pages.map(({ slug, path: pagePath }) => ({ slug, path: pagePath })),
    [
      { slug: 'guide', path: 'manual/guide' },
      { slug: 'guide', path: 'reference/guide' },
    ],
  );
  assert.deepEqual(previewData.site.front_page, {
    type: 'page',
    page_path: 'reference/guide',
  });
  assert.deepEqual(previewData.collections.guides.items, [
    { type: 'page', path: 'manual/guide' },
    { type: 'page', path: 'reference/guide' },
  ]);
  await fs.access(path.join(tempDir, '_site', 'index.html'));
  await fs.access(path.join(tempDir, '_site', 'manual', 'guide.html'));
  await assert.rejects(fs.access(path.join(tempDir, '_site', 'reference', 'guide.html')), /ENOENT/);
});

test('adds git updated_at timestamp and honors page-level overrides', async () => {
  const tempDir = await makeTempDir();
  const sourceDir = path.join(tempDir, 'docs');
  await fs.mkdir(path.join(sourceDir, '.zeropress'), { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'index.md'), '# Home\n\nContent.', 'utf8');
  await fs.writeFile(path.join(sourceDir, 'skip.md'), [
    '---',
    'updated_at: none',
    '---',
    '',
    '# Skip Date',
    '',
    'Content.',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(sourceDir, 'manual.md'), [
    '---',
    'updated_at: "2026-01-01T00:00:00Z"',
    '---',
    '',
    '# Manual Date',
    '',
    'Content.',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(sourceDir, 'legacy-meta.md'), [
    '---',
    'meta:',
    '  last_updated_iso: "2000-01-01T00:00:00Z"',
    '  last_updated: "2000-01-01"',
    '---',
    '',
    '# Legacy Meta Date',
    '',
    'Content.',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(sourceDir, '.zeropress', 'config.json'), JSON.stringify({
    version: '1.0',
    markdown: {
      updated_at: 'git',
    },
    front_page: {
      type: 'markdown',
    },
  }, null, 2), 'utf8');
  commitFixture(tempDir, '2026-05-27T11:20:30+09:00');

  await runBuildPages({
    cwd: tempDir,
    source: 'docs',
    destination: '_site',
    theme: 'docs',
    themePath: path.join(packageDir, 'themes', 'docs1'),
    skipLinkCheck: true,
  });

  const previewData = JSON.parse(await fs.readFile(path.join(tempDir, '.zeropress-build-pages', 'preview-data.json'), 'utf8'));
  const resolvedConfig = JSON.parse(await fs.readFile(path.join(tempDir, '.zeropress-build-pages', 'build-pages-config.json'), 'utf8'));
  const pages = new Map(previewData.content.pages.map((page) => [page.slug, page]));

  assert.deepEqual(resolvedConfig.markdown, {
    updated_at: 'git',
    link_output: 'clean',
  });
  assert.equal(pages.get('index').updated_at_iso, '2026-05-27T11:20:30+09:00');
  assert.equal(Object.hasOwn(pages.get('skip'), 'updated_at_iso'), false);
  assert.equal(pages.get('manual').updated_at_iso, '2026-01-01T00:00:00Z');
  assert.equal(pages.get('legacy-meta').updated_at_iso, '2026-05-27T11:20:30+09:00');
  assert.equal(pages.get('legacy-meta').meta.last_updated_iso, '2000-01-01T00:00:00Z');
  assert.equal(pages.get('legacy-meta').meta.last_updated, '2000-01-01');
});

test('front matter can opt into git updated_at when config default is none', async () => {
  const tempDir = await makeTempDir();
  const sourceDir = path.join(tempDir, 'docs');
  await fs.mkdir(path.join(sourceDir, '.zeropress'), { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'index.md'), [
    '---',
    'updated_at: git',
    '---',
    '',
    '# Home',
    '',
    'Content.',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(sourceDir, '.zeropress', 'config.json'), JSON.stringify({
    version: '1.0',
    markdown: {
      updated_at: 'none',
    },
    front_page: {
      type: 'markdown',
    },
  }, null, 2), 'utf8');
  commitFixture(tempDir, '2026-06-02T03:04:05Z');

  await runBuildPages({
    cwd: tempDir,
    source: 'docs',
    destination: '_site',
    theme: 'docs',
    themePath: path.join(packageDir, 'themes', 'docs1'),
    skipLinkCheck: true,
  });

  const previewData = JSON.parse(await fs.readFile(path.join(tempDir, '.zeropress-build-pages', 'preview-data.json'), 'utf8'));
  const home = previewData.content.pages.find((page) => page.slug === 'index');
  assert.equal(home.updated_at_iso, '2026-06-02T03:04:05Z');
});

test('git updated_at follows the source file repository when invoked outside it', async () => {
  const repositoryDir = await makeTempDir();
  const sourceDir = path.join(repositoryDir, 'docs');
  await fs.mkdir(path.join(sourceDir, '.zeropress'), { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'index.md'), '# Home\n\nContent.', 'utf8');
  await fs.writeFile(path.join(sourceDir, '.zeropress', 'config.json'), JSON.stringify({
    version: '1.0',
    markdown: {
      updated_at: 'git',
    },
    front_page: {
      type: 'markdown',
    },
  }, null, 2), 'utf8');
  commitFixture(repositoryDir, '2026-06-03T04:05:06-04:00');

  for (const scriptPath of [prebuildScript, bundledPrebuildPath]) {
    const invocationDir = await makeTempDir();
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: invocationDir,
      env: {
        ...process.env,
        ZEROPRESS_BUILD_PAGES_SOURCE: sourceDir,
        ZEROPRESS_SKIP_UNTITLED_MARKDOWN: 'false',
      },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, `${scriptPath}\n${result.stderr}`);
    assert.doesNotMatch(result.stderr, /could not read git updated_at/);
    const previewData = JSON.parse(await fs.readFile(
      path.join(invocationDir, '.zeropress-build-pages', 'preview-data.json'),
      'utf8',
    ));
    assert.equal(previewData.content.pages[0].updated_at_iso, '2026-06-03T04:05:06-04:00');
  }
});

test('git updated_at warning is non-blocking when git history is unavailable', () => {
  const tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'zeropress-build-pages-no-git-'));
  const sourceDir = path.join(tempDir, 'docs');
  fsSync.mkdirSync(path.join(sourceDir, '.zeropress'), { recursive: true });
  fsSync.writeFileSync(path.join(sourceDir, 'index.md'), '# Home\n\nContent.', 'utf8');
  fsSync.writeFileSync(path.join(sourceDir, '.zeropress', 'config.json'), JSON.stringify({
    version: '1.0',
    markdown: {
      updated_at: 'git',
    },
    front_page: {
      type: 'markdown',
    },
  }, null, 2), 'utf8');

  const result = spawnSync(process.execPath, [prebuildScript], {
    cwd: tempDir,
    env: {
      ...process.env,
      ZEROPRESS_BUILD_PAGES_SOURCE: sourceDir,
      ZEROPRESS_SKIP_UNTITLED_MARKDOWN: 'false',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Warning: could not read git updated_at/);
  assert.match(result.stdout, /Wrote \.zeropress-build-pages\/preview-data\.json with 1 pages/);
});

test('warns and ignores invalid front matter updated_at values', () => {
  for (const invalidUpdatedAt of ['yesterday', '2026-05-27']) {
    const tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'zeropress-build-pages-invalid-updated-at-'));
    const sourceDir = path.join(tempDir, 'docs');
    fsSync.mkdirSync(path.join(sourceDir, '.zeropress'), { recursive: true });
    fsSync.writeFileSync(path.join(sourceDir, 'index.md'), [
      '---',
      `updated_at: ${invalidUpdatedAt}`,
      '---',
      '',
      '# Home',
      '',
      'Content.',
    ].join('\n'), 'utf8');
    fsSync.writeFileSync(path.join(sourceDir, '.zeropress', 'config.json'), JSON.stringify({
      version: '1.0',
      markdown: {
        updated_at: 'git',
      },
      front_page: {
        type: 'markdown',
      },
    }, null, 2), 'utf8');

    const result = spawnSync(process.execPath, [prebuildScript], {
      cwd: tempDir,
      env: {
        ...process.env,
        ZEROPRESS_BUILD_PAGES_SOURCE: sourceDir,
        ZEROPRESS_SKIP_UNTITLED_MARKDOWN: 'false',
      },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Warning: ignored invalid front matter updated_at/);
    const previewData = JSON.parse(fsSync.readFileSync(path.join(tempDir, '.zeropress-build-pages', 'preview-data.json'), 'utf8'));
    const home = previewData.content.pages.find((page) => page.slug === 'index');
    assert.equal(Object.hasOwn(home, 'updated_at_iso'), false);
  }
});

test('warns and omits invalid front matter featured_image values', () => {
  const tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'zeropress-build-pages-invalid-featured-image-'));
  const sourceDir = path.join(tempDir, 'docs');
  const publicDir = path.join(tempDir, 'public');
  fsSync.mkdirSync(sourceDir, { recursive: true });
  fsSync.mkdirSync(publicDir, { recursive: true });

  const pages = new Map([
    ['index.md', [
      '---',
      'featured_image: /images/share.png',
      '---',
      '',
      '# Home',
    ]],
    ['unsafe.md', [
      '---',
      'featured_image: javascript:alert(1)',
      '---',
      '',
      '# Unsafe',
    ]],
    ['missing.md', [
      '---',
      'featured_image: ../public/missing.png',
      '---',
      '',
      '# Missing',
    ]],
    ['typed.md', [
      '---',
      'featured_image: 123',
      '---',
      '',
      '# Typed',
    ]],
  ]);

  for (const [fileName, lines] of pages) {
    fsSync.writeFileSync(path.join(sourceDir, fileName), lines.join('\n'), 'utf8');
  }

  const result = spawnSync(process.execPath, [prebuildScript], {
    cwd: tempDir,
    env: {
      ...process.env,
      ZEROPRESS_BUILD_PAGES_SOURCE: sourceDir,
      ZEROPRESS_BUILD_PAGES_PUBLIC_DIR: publicDir,
      ZEROPRESS_SITE_URL: '',
      ZEROPRESS_SKIP_UNTITLED_MARKDOWN: 'false',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    (result.stderr.match(/Warning: ignored invalid front matter featured_image/g) || []).length,
    4,
  );
  assert.match(result.stderr, /site\.url is required/);
  assert.match(result.stderr, /featured_image must use http: or https:/);
  assert.match(result.stderr, /source-relative featured_image must point to an existing file inside public-dir/);
  assert.match(result.stderr, /featured_image must be a non-empty string/);

  const previewData = JSON.parse(fsSync.readFileSync(path.join(tempDir, '.zeropress-build-pages', 'preview-data.json'), 'utf8'));
  for (const page of previewData.content.pages) {
    assert.equal(Object.hasOwn(page, 'featured_image'), false);
  }
});

test('rejects invalid markdown config', async () => {
  for (const markdownConfig of [
    { updated_at: 'mtime' },
    { link_output: 'pretty' },
  ]) {
    const tempDir = await makeTempDir();
    const sourceDir = path.join(tempDir, 'docs');
    await fs.mkdir(path.join(sourceDir, '.zeropress'), { recursive: true });
    await fs.writeFile(path.join(sourceDir, 'index.md'), '# Home\n\nContent.', 'utf8');
    await fs.writeFile(path.join(sourceDir, '.zeropress', 'config.json'), JSON.stringify({
      version: '1.0',
      markdown: markdownConfig,
      front_page: {
        type: 'markdown',
      },
    }, null, 2), 'utf8');

    await assert.rejects(
      () => runBuildPages({
        cwd: tempDir,
        source: 'docs',
        destination: '_site',
        themePath: path.join(packageDir, 'themes', 'docs1'),
        skipLinkCheck: true,
      }),
      /Build pages prebuild failed/,
    );
  }
});

test('rejects invalid site logo and site meta config', async () => {
  const cases = [
    {
      site: { logo: { alt: 'Missing src' } },
    },
    {
      site: { logo: { src: '//cdn.example.com/logo.svg' } },
    },
    {
      site: { logo: { src: './logo.svg' } },
    },
    {
      site: { logo: { src: '../logo.svg' } },
    },
    {
      site: { logo: { src: 'logo.svg' } },
    },
    {
      site: { logo: { src: 'ftp://cdn.example.com/logo.svg' } },
    },
    {
      site: { logo: { src: '/logo.svg', alt: 1 } },
    },
    {
      site: { logo: { src: '/logo.svg', width: 120 } },
    },
    {
      site: { meta: ['bad'] },
    },
    {
      site: { meta: { nested: { bad: true } } },
    },
  ];

  for (const { site } of cases) {
    const tempDir = await makeTempDir();
    const sourceDir = path.join(tempDir, 'docs');
    await fs.mkdir(path.join(sourceDir, '.zeropress'), { recursive: true });
    await fs.writeFile(path.join(sourceDir, 'index.md'), '# Home\n\nContent.', 'utf8');
    await fs.writeFile(path.join(sourceDir, '.zeropress', 'config.json'), JSON.stringify({
      version: '1.0',
      site,
      front_page: {
        type: 'markdown',
      },
    }, null, 2), 'utf8');

    await assert.rejects(
      () => runBuildPages({
        cwd: tempDir,
        source: 'docs',
        destination: '_site',
        themePath: path.join(packageDir, 'themes', 'docs1'),
        skipLinkCheck: true,
      }),
      /Build pages prebuild failed/,
    );
  }
});

test('rejects invalid config collections', async () => {
  const cases = [
    {
      name: 'duplicate',
      collections: {
        docs: {
          title: 'Docs',
          items: ['index.md', 'index.md'],
        },
      },
      stderr: /duplicates index\.md/,
    },
    {
      name: 'missing',
      collections: {
        docs: {
          title: 'Docs',
          items: ['missing.md'],
        },
      },
      stderr: /was not discovered as a Markdown page: missing\.md/,
    },
    {
      name: 'non-markdown',
      collections: {
        docs: {
          title: 'Docs',
          items: ['notes.txt'],
        },
      },
      stderr: /must be a Markdown source path ending in \.md/,
    },
    {
      name: 'draft',
      collections: {
        docs: {
          title: 'Docs',
          items: ['draft.md'],
        },
      },
      stderr: /references skipped Markdown draft\.md: front matter status is "draft"/,
    },
  ];

  for (const testCase of cases) {
    const tempDir = await makeTempDir();
    const sourceDir = path.join(tempDir, 'docs');
    await fs.mkdir(path.join(sourceDir, '.zeropress'), { recursive: true });
    await fs.writeFile(path.join(sourceDir, 'index.md'), '# Home\n\nContent.', 'utf8');
    await fs.writeFile(path.join(sourceDir, 'draft.md'), [
      '---',
      'status: draft',
      '---',
      '',
      '# Draft',
      '',
      'Draft content.',
    ].join('\n'), 'utf8');
    await fs.writeFile(path.join(sourceDir, '.zeropress', 'config.json'), JSON.stringify({
      version: '1.0',
      front_page: { type: 'markdown', file: 'index.md' },
      collections: testCase.collections,
    }, null, 2), 'utf8');

    const result = spawnSync(process.execPath, [prebuildScript], {
      cwd: tempDir,
      env: {
        ...process.env,
        ZEROPRESS_BUILD_PAGES_SOURCE: sourceDir,
        ZEROPRESS_SKIP_UNTITLED_MARKDOWN: 'false',
      },
      encoding: 'utf8',
    });

    assert.notEqual(result.status, 0, testCase.name);
    assert.match(result.stderr, testCase.stderr, testCase.name);
  }
});

test('link checker reports broken links without throwing', async () => {
  const tempDir = await makeTempDir();
  const siteDir = path.join(tempDir, '_site');
  await fs.mkdir(path.join(siteDir, 'docs', 'topic'), { recursive: true });
  await fs.mkdir(path.join(siteDir, 'docs'), { recursive: true });
  await fs.mkdir(path.join(siteDir, 'assets'), { recursive: true });
  await fs.writeFile(path.join(siteDir, 'assets', 'logo.png'), 'logo', 'utf8');
  await fs.writeFile(path.join(siteDir, 'assets', 'large.png'), 'large', 'utf8');
  await fs.writeFile(path.join(siteDir, 'docs', 'index.html'), '<h1>Docs</h1>', 'utf8');
  await fs.writeFile(path.join(siteDir, 'docs', 'topic', 'index.html'), [
    '<img src="../../assets/logo.png">',
    '<img srcset="../../assets/logo.png 1x, ../../assets/large.png 2x">',
    '<video poster="../../assets/logo.png"></video>',
    '<a href="../">Parent</a>',
    '<a href="/assets/logo.png">Root</a>',
    '<a href="../../../outside.txt">Escape</a>',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(siteDir, 'index.html'), '<a href="/missing">Missing</a>', 'utf8');

  const result = await checkInternalLinks(siteDir);
  assert.equal(result.htmlFiles.length, 3);
  assert.deepEqual(result.brokenLinks.sort(), [
    'docs/topic/index.html -> ../../../outside.txt',
    'index.html -> /missing',
  ]);
});

test('action metadata and entrypoint use supported inputs', async () => {
  const action = await fs.readFile(path.join(packageDir, 'action.yml'), 'utf8');
  for (const inputName of ['source', 'public-dir', 'destination', 'theme', 'theme-path', 'config', 'site-url', 'skip-untitled-markdown', 'skip-link-check', 'copy-markdown-source']) {
    assert.match(action, new RegExp(`\\n  ${inputName}:`));
  }
  assert.match(action, /default: \.\/docs/);
  assert.match(action, /plain/);
  await fs.access(bundledPrebuildPath);

  const tempDir = await makeTempDir();
  await fs.mkdir(path.join(tempDir, 'docs'), { recursive: true });
  await fs.mkdir(path.join(tempDir, 'public'), { recursive: true });
  await fs.writeFile(path.join(tempDir, 'docs', 'index.md'), '# Home\n\nAction build.', 'utf8');
  await fs.writeFile(path.join(tempDir, 'public', 'asset.txt'), 'asset', 'utf8');
  const result = spawnSync(process.execPath, [actionPath], {
    cwd: tempDir,
    env: {
      ...process.env,
      'INPUT_PUBLIC-DIR': 'public',
      INPUT_DESTINATION: '_site',
      INPUT_THEME: 'docs2',
      'INPUT_SITE-URL': 'https://example.com',
      'INPUT_SKIP-LINK-CHECK': 'true',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ZeroPress Build Pages \d+\.\d+\.\d+/);
  assert.match(result.stdout, /Docs: https:\/\/build-pages\.zeropress\.dev\//);
  assert.match(result.stdout, new RegExp(`Theme: ${escapeRegExp(await readBundledThemeId('docs2'))}`));
  assert.match(result.stdout, /Source config: .*\.zeropress\/config\.json \(not found; using defaults\)/);
  assert.match(result.stdout, /Config reference: https:\/\/build-pages\.zeropress\.dev\/reference\/config\//);
  assert.match(result.stdout, /Resolved config: \.zeropress-build-pages\/build-pages-config\.json \(generated effective config\)/);
  await fs.access(path.join(tempDir, '_site', 'index.html'));
  await fs.access(path.join(tempDir, '_site', 'index.md'));
  await fs.access(path.join(tempDir, '_site', 'asset.txt'));
  await fs.access(path.join(tempDir, '_site', 'sitemap.xml'));
  assert.equal(await pathExists(path.join(tempDir, '_site', 'feed.xml')), false);

  const privateTempDir = await makeTempDir();
  await fs.mkdir(path.join(privateTempDir, 'docs'), { recursive: true });
  await fs.writeFile(path.join(privateTempDir, 'docs', 'index.md'), '# Private Home\n\nAction build.', 'utf8');
  const privateResult = spawnSync(process.execPath, [actionPath], {
    cwd: privateTempDir,
    env: {
      ...process.env,
      INPUT_DESTINATION: '_site',
      INPUT_THEME: 'docs',
      'INPUT_SKIP-LINK-CHECK': 'true',
      'INPUT_COPY-MARKDOWN-SOURCE': 'false',
    },
    encoding: 'utf8',
  });

  assert.equal(privateResult.status, 0, privateResult.stderr);
  await fs.access(path.join(privateTempDir, '_site', 'index.html'));
  assert.equal(await pathExists(path.join(privateTempDir, '_site', 'index.md')), false);

  const subdirectoryTempDir = await makeTempDir();
  await fs.mkdir(path.join(subdirectoryTempDir, 'docs'), { recursive: true });
  await fs.writeFile(path.join(subdirectoryTempDir, 'docs', 'index.md'), '# Subdirectory Home\n\nAction build.', 'utf8');
  const subdirectoryResult = spawnSync(process.execPath, [actionPath], {
    cwd: subdirectoryTempDir,
    env: {
      ...process.env,
      INPUT_DESTINATION: '_site',
      INPUT_THEME: 'docs',
      'INPUT_SITE-URL': 'https://example.com/docs',
      'INPUT_SKIP-LINK-CHECK': 'true',
    },
    encoding: 'utf8',
  });

  assert.notEqual(subdirectoryResult.status, 0);
  assert.match(subdirectoryResult.stderr, /site\.url must use the origin root/);
  assert.equal(await pathExists(path.join(subdirectoryTempDir, '_site')), false);
});

test('bundled action includes the canonical theme package hard limits', async () => {
  const actionBundle = await fs.readFile(actionPath, 'utf8');
  for (const code of [
    'THEME_PACKAGE_TOO_MANY_ENTRIES',
    'THEME_FILE_TOO_LARGE',
    'THEME_PACKAGE_TOO_LARGE',
  ]) {
    assert.match(actionBundle, new RegExp(code));
  }
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

function commitFixture(cwd, isoDate) {
  const env = {
    ...process.env,
    GIT_AUTHOR_DATE: isoDate,
    GIT_COMMITTER_DATE: isoDate,
  };
  for (const args of [
    ['init'],
    ['config', 'user.name', 'ZeroPress Test'],
    ['config', 'user.email', 'test@example.com'],
    ['add', '.'],
    ['commit', '-m', 'fixture'],
  ]) {
    const result = spawnSync('git', args, {
      cwd,
      env,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
