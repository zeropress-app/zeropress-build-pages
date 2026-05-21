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
const bundledPrebuildPath = path.join(packageDir, 'dist', 'prebuild.js');
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
  assert.match(help.stdout, /Dedicated source directory \(required\)/);

  const version = spawnSync(process.execPath, [binPath, '--version'], {
    cwd: packageDir,
    encoding: 'utf8',
  });
  assert.equal(version.status, 0);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
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

  assert.deepEqual(parseArgs(['--source', 'docs', '--destination', 'site']), {
    source: 'docs',
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
  assert.equal(parsed.destination, 'dist');
  assert.equal(parsed.themePath, 'custom-theme');
  assert.equal(parsed.siteUrl, 'https://override.example');
  assert.equal(parsed.skipUntitledMarkdown, true);
  assert.equal(parsed.skipLinkCheck, true);
  assert.equal(parsed.copyMarkdownSource, false);
});

const failureCases = [
  'invalid-front-page-type',
  'invalid-html-front-page-path',
  'missing-html-front-page-file',
  'missing-custom-html-file',
  'invalid-site-indexing',
  'invalid-site-search',
  'invalid-site-expose-generator',
  'invalid-menu-meta',
  'removed-site-field',
  'malformed-front-matter',
  'invalid-front-matter-path',
  'invalid-front-matter-discoverability',
  'invalid-front-matter-meta',
  'invalid-front-matter-data',
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
  const previewData = JSON.parse(await fs.readFile(path.join(tempDir, '.zeropress', 'preview-data.json'), 'utf8'));
  const buildReport = JSON.parse(await fs.readFile(path.join(tempDir, '.zeropress', 'build-report.json'), 'utf8'));
  const homePage = previewData.content.pages.find((page) => page.slug === 'index');
  const customPage = previewData.content.pages.find((page) => page.slug === 'custom-page');

  assert.equal(previewData.site.indexing, true);
  assert.equal(previewData.site.expose_generator, true);
  assert.equal(homePage.title, 'Front Matter Home');
  assert.equal(homePage.excerpt, 'Home from front matter.');
  assert.equal(customPage.title, 'Custom Front Matter Title');
  assert.equal(customPage.excerpt, 'Custom front matter excerpt.');
  assert.equal(customPage.path, 'guides/custom-page');
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
  assert.match(indexHtml, /Front Matter Home/);
  assert.match(indexHtml, /<meta name="generator" content="ZeroPress">/);
  assert.match(indexHtml, /<link rel="icon" href="\/favicon\.ico" sizes="any">/);
  assert.match(indexHtml, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/);
  assert.match(indexHtml, /<link rel="icon" href="\/favicon\.png" type="image\/png">/);
  assert.match(indexHtml, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png">/);
  assert.match(indexHtml, /href="\/guide"/);
  assert.match(guideHtml, /href="\/guides\/custom-page"/);
  assert.match(guideHtml, /contains-task-list/);
  assert.match(customHtml, /Body Heading/);
  assert.match(customHtml, /<meta name="robots" content="noindex">/);
  assert.match(customHtml, /View this page as Markdown/);
  assert.doesNotMatch(customHtml, /title: Custom Front Matter Title|---/);
  const searchItems = JSON.parse(await fs.readFile(path.join(tempDir, '_site', '_zeropress', 'search.json'), 'utf8'));
  assert.equal(searchItems.some((item) => item.id === 'page:custom-page'), false);
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
  await fs.access(path.join(tempDir, '.zeropress', 'preview-data.json'));
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
  const previewData = JSON.parse(await fs.readFile(path.join(tempDir, '.zeropress', 'preview-data.json'), 'utf8'));
  const buildReport = JSON.parse(await fs.readFile(path.join(tempDir, '.zeropress', 'build-report.json'), 'utf8'));
  const resolvedConfig = JSON.parse(await fs.readFile(path.join(tempDir, '.zeropress', 'build-pages-config.json'), 'utf8'));
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
    site: {
      indexing: true,
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
  await fs.writeFile(path.join(tempDir, '.zeropress', 'config.json'), '{"version":"0.1"}', 'utf8');
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
  await fs.mkdir(path.join(tempDir, '.zeropress', 'source'), { recursive: true });
  await fs.mkdir(path.join(tempDir, 'custom-theme'), { recursive: true });

  await assert.rejects(
    runBuildPages({
      cwd: tempDir,
      source: '.zeropress/source',
      destination: '_site',
      theme: 'docs',
      skipLinkCheck: true,
    }),
    /Source directory must not overlap the internal \.zeropress working directory/,
  );

  await assert.rejects(
    runBuildPages({
      cwd: tempDir,
      source: 'docs',
      destination: '.zeropress/site',
      theme: 'docs',
      skipLinkCheck: true,
    }),
    /Destination directory must not overlap the internal \.zeropress working directory/,
  );

  await assert.rejects(
    runBuildPages({
      cwd: tempDir,
      source: 'docs',
      destination: '_site',
      themePath: '.zeropress/theme',
      skipLinkCheck: true,
    }),
    /Theme directory must not overlap the internal \.zeropress working directory/,
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
});

test('builds with config, custom theme path, and source inside a subdirectory', async () => {
  const tempDir = await makeTempDir();
  const sourceDir = path.join(tempDir, 'docs');
  await fs.mkdir(path.join(sourceDir, '.zeropress'), { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'index.md'), '# Home\n\nConfigured home.', 'utf8');
  await fs.writeFile(path.join(sourceDir, 'topic.md'), '# Topic\n\nContent.', 'utf8');
  await fs.writeFile(path.join(sourceDir, '.zeropress', 'head-end.html'), '<meta name="test-head" content="ok">', 'utf8');
  await fs.writeFile(path.join(sourceDir, '.zeropress', 'config.json'), JSON.stringify({
    version: '0.1',
    site: {
      title: 'Configured Docs',
      description: 'A configured docs site.',
      url: 'https://config.example',
      expose_generator: false,
      search: false,
      indexing: false,
      footer: {
        copyright_text: 'Copyright 2026 Example Corp.',
        attribution: false,
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
  const previewData = JSON.parse(await fs.readFile(path.join(tempDir, '.zeropress', 'preview-data.json'), 'utf8'));
  assert.equal(previewData.$schema, 'https://zeropress.dev/schemas/preview-data.v0.6.schema.json');
  assert.deepEqual(previewData.custom_html, {
    head_end: {
      content: '<meta name="test-head" content="ok">',
    },
  });
  assert.deepEqual(previewData.site.footer, {
    copyright_text: 'Copyright 2026 Example Corp.',
    attribution: false,
  });
  assert.equal(previewData.site.url, 'https://override.example');
  assert.equal(previewData.site.media_base_url, '');
  assert.equal(previewData.site.locale, 'en-US');
  assert.equal(previewData.site.posts_per_page, 10);
  assert.equal(previewData.site.datetime_display, 'static');
  assert.equal(previewData.site.date_style, 'medium');
  assert.equal(previewData.site.time_style, 'none');
  assert.equal(previewData.site.timezone, 'UTC');
  assert.equal(previewData.site.expose_generator, false);
  assert.equal(previewData.site.search, false);
  assert.equal(previewData.site.indexing, false);
  assert.deepEqual(previewData.site.permalinks, {
    output_style: 'html-extension',
    posts: '/posts/:slug/',
    pages: '/:slug/',
    categories: '/categories/:slug/',
    tags: '/tags/:slug/',
  });
  assert.equal(previewData.site.disallow_comments, true);
  const resolvedConfig = JSON.parse(await fs.readFile(path.join(tempDir, '.zeropress', 'build-pages-config.json'), 'utf8'));
  assert.equal(resolvedConfig.$schema, 'https://zeropress.dev/schemas/zeropress-build-pages.config.v0.1.schema.json');
  assert.equal(resolvedConfig.version, '0.1');
  assert.deepEqual(resolvedConfig.front_page, {
    type: 'markdown',
    file: 'index.md',
  });
  assert.deepEqual(resolvedConfig.custom_html, {
    head_end: {
      file: '.zeropress/head-end.html',
    },
  });
  assert.deepEqual(resolvedConfig.site, {
    title: 'Configured Docs',
    description: 'A configured docs site.',
    url: 'https://override.example',
    expose_generator: false,
    search: false,
    indexing: false,
    footer: {
      copyright_text: 'Copyright 2026 Example Corp.',
      attribution: false,
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
  for (const key of ['media_base_url', 'locale', 'posts_per_page', 'datetime_display', 'date_style', 'time_style', 'timezone', 'permalinks', 'disallow_comments']) {
    assert.equal(Object.hasOwn(resolvedConfig.site, key), false);
  }
  assert.deepEqual(resolvedConfig.menus.primary.items[1], {
    title: 'Topic',
    url: '/topic',
    type: 'custom',
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
  for (const inputName of ['source', 'destination', 'theme', 'theme-path', 'config', 'site-url', 'skip-untitled-markdown', 'skip-link-check', 'copy-markdown-source']) {
    assert.match(action, new RegExp(`\\n  ${inputName}:`));
  }
  assert.match(action, /default: \.\/docs/);
  await fs.access(bundledPrebuildPath);

  const tempDir = await makeTempDir();
  await fs.mkdir(path.join(tempDir, 'docs'), { recursive: true });
  await fs.writeFile(path.join(tempDir, 'docs', 'index.md'), '# Home\n\nAction build.', 'utf8');
  const result = spawnSync(process.execPath, [actionPath], {
    cwd: tempDir,
    env: {
      ...process.env,
      INPUT_DESTINATION: '_site',
      INPUT_THEME: 'docs',
      'INPUT_SKIP-LINK-CHECK': 'true',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  await fs.access(path.join(tempDir, '_site', 'index.html'));
  await fs.access(path.join(tempDir, '_site', 'index.md'));

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
