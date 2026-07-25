import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, '..');
const prebuildScript = path.join(packageDir, 'src', 'prebuild.js');
const bundledPrebuildScript = path.join(packageDir, 'dist', 'prebuild.js');
const schemaPath = path.join(packageDir, 'schemas', 'zeropress-build-pages.config.v1.0.schema.json');
const historicalSchemaPath = path.join(packageDir, 'schemas', 'zeropress-build-pages.config.v0.1.schema.json');
const HISTORICAL_SCHEMA_SHA256 = '3a295a9b83f005fcbf85dd9771ff2b66ee6fbeec2bfe030309fefe933e339a80';

test('config envelope and nested config objects reject schema-invalid values before writing outputs', async () => {
  const cases = [
    [{ version: '9.9' }, /version must be exactly "1\.0"/],
    [{ version: '0.7' }, /version must be exactly "1\.0"/],
    [{ version: '0.1' }, /version must be exactly "1\.0"/],
    [{ version: 1.0 }, /version must be exactly "1\.0"/],
    [{ version: '' }, /version must be exactly "1\.0"/],
    [{ version: ' 1.0 ' }, /version must be exactly "1\.0"/],
    [{ version: null }, /version must be exactly "1\.0"/],
    [{ version: true }, /version must be exactly "1\.0"/],
    [{ unknown_root: true }, /config contains unknown field "unknown_root"/],
    [{ $schema: 42 }, /\$schema must be a string/],
    [{ site: { title: 42 } }, /site\.title must be a non-empty string/],
    [{ site: { description: 42 } }, /site\.description must be a string/],
    [{ site: { url: 'https:\\example.com' } }, /site\.url must be an absolute http: or https: URL/],
    [{ site: { url: 'https://example.com:' } }, /site\.url must be an absolute http: or https: URL/],
    [{ site: { url: 'https://@example.com' } }, /site\.url must be an absolute http: or https: URL/],
    [{ site: { url: 'https://example.com:99999' } }, /site\.url must be an absolute http: or https: URL/],
    [{ site: { locale: 'x' } }, /site\.locale must be a valid BCP 47 language tag/],
    [{ site: { locale: '😀' } }, /site\.locale must be a valid BCP 47 language tag/],
    [{ site: { locale: ' en-US ' } }, /site\.locale must be a non-empty locale string/],
    [{ site: { logo: { src: ' /logo.svg' } } }, /site\.logo\.src must not contain leading or trailing whitespace/],
    [{ site: { logo: { src: '/logo mark.svg' } } }, /site\.logo\.src contains an unsafe or malformed URL character/],
    [{ site: { logo: { src: '/logo-%ZZ.svg' } } }, /site\.logo\.src contains an unsafe or malformed URL character/],
    [{ site: { logo: { src: '/' } } }, /site\.logo\.src must be a root-relative URL path/],
    [{ site: { logo: { src: '/assets/../logo.svg' } } }, /site\.logo\.src must be a root-relative URL path/],
    [{ site: { logo: { src: 'https://example.com' } } }, /site\.logo\.src must be a root-relative URL path/],
    [{ site: { logo: { src: 'https://user@example.com/logo.svg' } } }, /site\.logo\.src must be a root-relative URL path/],
    [{ site: { logo: { src: 'https://example.com/assets/../logo.svg' } } }, /site\.logo\.src must be a root-relative URL path/],
    [{ site: { logo: { src: 'https://example.com:' } } }, /site\.logo\.src must be a root-relative URL path/],
    [{ site: { logo: { src: 'https://@example.com/logo.svg' } } }, /site\.logo\.src must be a root-relative URL path/],
    [{ site: { logo: { src: 'https://example.com:99999/logo.svg' } } }, /site\.logo\.src must be a root-relative URL path/],
    [{ site: { footer: { copyright_text: '' } } }, /site\.footer\.copyright_text must be a non-empty string/],
    [{ site: { footer: { extra: true } } }, /site\.footer contains unknown field "extra"/],
    [{ menus: { Primary: { items: [] } } }, /menus\.Primary must use a lowercase config id/],
    [{ menus: { primary: { items: [], extra: true } } }, /menus\.primary contains unknown field "extra"/],
    [{ menus: { primary: { name: 42, items: [] } } }, /menus\.primary\.name must be a non-empty string/],
    [{ menus: { primary: { items: [{ title: 42, url: '/' }] } } }, /items\[0\]\.title must be a non-empty string/],
    [{ menus: { primary: { items: [{ title: 'Docs', url: '/', type: 'page' }] } } }, /items\[0\] contains unknown field "type"/],
    [{ menus: { primary: { items: [{ title: 'Docs', url: '/', target: '_top' }] } } }, /items\[0\]\.target must be one of/],
    [{ menus: { primary: { items: [{ title: 'Docs', url: '/', children: {} }] } } }, /items\[0\]\.children must be an array/],
    [{ menus: { primary: { items: [{ title: 'Docs', url: '/', extra: true }] } } }, /items\[0\] contains unknown field "extra"/],
    [{ collections: { docs: { title: 42, items: [] } } }, /collections\.docs\.title must be a non-empty string/],
    [{ collections: { docs: { description: 42, items: [] } } }, /collections\.docs\.description must be a string/],
    [{ collections: { docs: { items: [], extra: true } } }, /collections\.docs contains unknown field "extra"/],
  ];

  for (const [config, expectedError] of cases) {
    const authoredConfig = Object.hasOwn(config, 'version') ? config : { version: '1.0', ...config };
    const { cwd, sourceDir } = await createSource(authoredConfig);
    const result = runPrebuild(cwd, sourceDir);

    assert.notEqual(result.status, 0, JSON.stringify(config));
    assert.match(result.stderr, expectedError, JSON.stringify(config));
    await assertNoGeneratedOutputs(cwd);
  }
});

test('configured source file paths are exact and are not silently trimmed, slash-normalized, or case-folded', async () => {
  const cases = [
    [{ front_page: { type: 'markdown', file: ' index.md' } }, /safe source-root relative path/],
    [{ front_page: { type: 'markdown', file: 'sub\\index.md' } }, /safe source-root relative path/],
    [{ front_page: { type: 'markdown', file: 'index.MD' } }, /must end with \.md/],
    [{ custom_html: { head_end: { file: '.zeropress/head.HTML' } } }, /must be an HTML file inside \.zeropress/],
    [{ collections: { docs: { items: ['index.MD'] } } }, /must be a Markdown source path ending in \.md/],
  ];

  for (const [partialConfig, expectedError] of cases) {
    const config = { version: '1.0', ...partialConfig };
    const { cwd, sourceDir } = await createSource(config);
    const result = runPrebuild(cwd, sourceDir);

    assert.notEqual(result.status, 0, JSON.stringify(config));
    assert.match(result.stderr, expectedError, JSON.stringify(config));
    await assertNoGeneratedOutputs(cwd);
  }
});

test('custom HTML source slots materialize as raw strings and enforce nonblank 65,536-code-point content', async () => {
  const config = {
    version: '1.0',
    custom_html: {
      head_end: {
        file: '.zeropress/head-end.html',
      },
    },
  };
  const rawHtml = ' \n<meta name="test" content="raw">\n ';
  const rawSource = await createSource(config, {
    '.zeropress/head-end.html': rawHtml,
  });
  const rawResult = runPrebuild(rawSource.cwd, rawSource.sourceDir);

  assert.equal(rawResult.status, 0, rawResult.stderr);
  const rawPreviewData = JSON.parse(await fs.readFile(
    path.join(rawSource.cwd, '.zeropress-build-pages', 'preview-data.json'),
    'utf8',
  ));
  assert.deepEqual(rawPreviewData.custom_html, {
    head_end: rawHtml,
  });

  const maximumHtml = '😀'.repeat(65_536);
  const maximumSource = await createSource(config, {
    '.zeropress/head-end.html': maximumHtml,
  });
  const maximumResult = runPrebuild(maximumSource.cwd, maximumSource.sourceDir);

  assert.equal(maximumResult.status, 0, maximumResult.stderr);
  const maximumPreviewData = JSON.parse(await fs.readFile(
    path.join(maximumSource.cwd, '.zeropress-build-pages', 'preview-data.json'),
    'utf8',
  ));
  assert.equal(maximumPreviewData.custom_html.head_end, maximumHtml);

  for (const [content, expectedError] of [
    [' \n\t', /custom_html\.head_end\.file must not be empty/],
    ['😀'.repeat(65_537), /custom_html\.head_end\.file exceeds the 65,536 Unicode code point limit/],
  ]) {
    const invalidSource = await createSource(config, {
      '.zeropress/head-end.html': content,
    });
    const invalidResult = runPrebuild(invalidSource.cwd, invalidSource.sourceDir);

    assert.notEqual(invalidResult.status, 0);
    assert.match(invalidResult.stderr, expectedError);
    assert.match(invalidResult.stderr, /\.zeropress\/head-end\.html/);
    await assertNoGeneratedOutputs(invalidSource.cwd);
  }
});

test('an environment site URL override does not mask an invalid configured site URL', async () => {
  const { cwd, sourceDir } = await createSource({
    version: '1.0',
    site: {
      url: 42,
    },
  });
  const result = runPrebuild(cwd, sourceDir, {
    ZEROPRESS_SITE_URL: 'https://override.example',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /site\.url must be a string/);
  await assertNoGeneratedOutputs(cwd);
});

test('the public Build Pages runner leaves no working output for invalid config', async () => {
  const { runBuildPages } = await import('../src/index.js');
  const { cwd } = await createSource({
    version: '9.9',
  });

  await assert.rejects(
    runBuildPages({
      cwd,
      source: 'docs',
      destination: '_site',
      theme: 'plain',
      skipLinkCheck: true,
    }),
    /Build pages prebuild failed/,
  );

  await assertNoGeneratedOutputs(cwd);
  await assert.rejects(fs.access(path.join(cwd, '_site')), { code: 'ENOENT' });
});

test('menu URLs accept credential-free absolute HTTP(S) and root-relative Web references', async () => {
  const urls = [
    '/',
    '/guide?mode=full#top',
    '/foo//bar',
    'https://example.com/docs/%E2%9C%93?q=ok#top',
    'HTTP://example.com/docs',
  ];
  const config = {
    version: '1.0',
    menus: {
      primary: {
        items: urls.map((url, index) => ({ title: `Item ${index}`, url })),
      },
    },
  };
  const { cwd, sourceDir } = await createSource(config);
  const result = runPrebuild(cwd, sourceDir);

  assert.equal(result.status, 0, result.stderr);
  const previewData = JSON.parse(await fs.readFile(path.join(cwd, '.zeropress-build-pages', 'preview-data.json'), 'utf8'));
  assert.deepEqual(previewData.menus.primary.items.map((item) => item.url), urls);
});

test('menu URLs reject non-Web, pathless, unsafe, and malformed references before writing outputs', async () => {
  const invalidUrls = [
    '',
    '//cdn.example.com/docs',
    'ftp://example.com/docs',
    'mailto:docs@example.com',
    'javascript:alert(1)',
    '?mode=full',
    '#top',
    'guide',
    'guides/start?mode=full#top',
    './guide',
    '../guide',
    'foo/../bar',
    'https://user:pass@example.com/docs',
    ' guide',
    'guide\\child',
    'guide/\u0085child',
    'guide/%ZZ',
    'guide/%00',
    '.',
    '..',
    './',
    '../',
    '../../',
    'http:example.com',
    'https:///docs',
    'https://example.com:/docs',
    'https://@example.com/docs',
    'https://example.com:99999/docs',
    'https://[::1/docs',
  ];

  for (const url of invalidUrls) {
    const config = {
      version: '1.0',
      menus: {
        primary: {
          items: [{ title: 'Invalid', url }],
        },
      },
    };
    const { cwd, sourceDir } = await createSource(config);
    const result = runPrebuild(cwd, sourceDir);

    assert.notEqual(result.status, 0, JSON.stringify(url));
    assert.match(result.stderr, /items\[0\]\.url/, JSON.stringify(url));
    await assertNoGeneratedOutputs(cwd);
  }
});

test('filename-derived and explicit routes use the shared Unicode slug policy', async () => {
  const { cwd, sourceDir } = await createSource({
    version: '1.0',
    menus: {
      primary: {
        items: [{ title: 'Theme Runtime v0.6', url: '/theme-runtime-v0.6' }],
      },
    },
  }, {
    'Café Guide!.md': '# Café Guide\n',
    '문서_안내.md': '# 문서 안내\n',
    'Theme Runtime v0.6.md': '# Theme Runtime v0.6\n',
    'explicit.md': [
      '---',
      'path: Cafe\u0301/설치_방법',
      '---',
      '# Explicit',
      '',
    ].join('\n'),
    'dotted-explicit.md': [
      '---',
      'path: spec/preview-data-v0.6',
      '---',
      '# Preview Data v0.6',
      '',
    ].join('\n'),
    'uppercase-html.md': [
      '---',
      'path: spec/page.HTML',
      '---',
      '# Uppercase HTML Suffix',
      '',
    ].join('\n'),
    'guides/index.md': '# Nested Index\n',
    [`${'a'.repeat(201)}.md`]: '# Long Filename\n',
  });
  const result = runPrebuild(cwd, sourceDir);

  assert.equal(result.status, 0, result.stderr);
  const previewData = JSON.parse(await fs.readFile(path.join(cwd, '.zeropress-build-pages', 'preview-data.json'), 'utf8'));
  const pages = new Map(previewData.content.pages.map((page) => [page.title, page]));
  assert.equal(Object.hasOwn(pages.get('Café Guide'), 'path'), false);
  assert.equal(pages.get('Café Guide').slug, 'café-guide');
  assert.equal(Object.hasOwn(pages.get('문서 안내'), 'path'), false);
  assert.equal(pages.get('문서 안내').slug, '문서_안내');
  assert.equal(Object.hasOwn(pages.get('Theme Runtime v0.6'), 'path'), false);
  assert.equal(pages.get('Theme Runtime v0.6').slug, 'theme-runtime-v0.6');
  assert.equal(pages.get('Explicit').path, 'Café/설치_방법');
  assert.equal(pages.get('Explicit').slug, '설치_방법');
  assert.equal(pages.get('Preview Data v0.6').path, 'spec/preview-data-v0.6');
  assert.equal(pages.get('Preview Data v0.6').slug, 'preview-data-v0.6');
  assert.equal(pages.get('Uppercase HTML Suffix').path, 'spec/page.HTML');
  assert.equal(pages.get('Nested Index').path, 'guides/index');
  assert.equal(pages.get('Nested Index').slug, 'guides');
  assert.equal(pages.get('Home').path, 'index');
  assert.equal(Object.hasOwn(pages.get('Long Filename'), 'path'), false);
  assert.equal(Array.from(pages.get('Long Filename').slug).length, 200);
  assert.equal(previewData.menus.primary.items[0].url, '/theme-runtime-v0.6');
});

test('explicit front matter routes reject disallowed and overlong slug segments', async () => {
  for (const routePath of ['news!', '.hidden', 'hidden.', 'a..b', 'a'.repeat(201)]) {
    const { cwd, sourceDir } = await createSource(undefined, {
      'invalid.md': [
        '---',
        `path: ${routePath}`,
        '---',
        '# Invalid',
        '',
      ].join('\n'),
    });
    const result = runPrebuild(cwd, sourceDir);

    assert.notEqual(result.status, 0, routePath);
    assert.match(result.stderr, /front matter path segment/);
    await assertNoGeneratedOutputs(cwd);
  }
});

test('explicit and filename-derived page routes reject literal lowercase .html suffix segments', async () => {
  for (const routePath of ['page.html', 'docs/page.html', 'docs/page.html/child']) {
    const { cwd, sourceDir } = await createSource(undefined, {
      'explicit.md': [
        '---',
        `path: ${routePath}`,
        '---',
        '# Explicit HTML Suffix',
        '',
      ].join('\n'),
    });
    const result = runPrebuild(cwd, sourceDir);

    assert.notEqual(result.status, 0, routePath);
    assert.match(result.stderr, /front matter path must not contain a segment ending with the literal lowercase suffix "\.html"/);
    await assertNoGeneratedOutputs(cwd);
  }

  for (const filename of ['page.html.md', 'docs/page.html.md', 'docs/page.html/child.md']) {
    const { cwd, sourceDir } = await createSource(undefined, {
      [filename]: '# Filename HTML Suffix\n',
    });
    const result = runPrebuild(cwd, sourceDir);

    assert.notEqual(result.status, 0, filename);
    assert.match(result.stderr, /filename-derived route must not contain a segment ending with the literal lowercase suffix "\.html"/);
    await assertNoGeneratedOutputs(cwd);
  }
});

test('page routes cannot claim the same public URL as a public file', async () => {
  const { cwd, sourceDir } = await createSource(undefined, {
    'favicon-page.md': [
      '---',
      'path: favicon.ico',
      '---',
      '# Favicon Page',
      '',
    ].join('\n'),
    'favicon.ico': 'icon',
  });
  const result = runPrebuild(cwd, sourceDir);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /route "\/favicon\.ico" conflicts with public file "\/favicon\.ico"/);
  await assertNoGeneratedOutputs(cwd);
});

test('filename-derived routes reject source segments that cannot produce a slug', async () => {
  for (const scriptPath of [prebuildScript, bundledPrebuildScript]) {
    const { cwd, sourceDir } = await createSource(undefined, {
      'guide.md': '# Root Guide\n',
      '!!!/guide.md': '# Nested Guide\n',
    });
    const result = runPrebuild(cwd, sourceDir, {}, scriptPath);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /source path segment "!!!" cannot derive a route slug/);
    await assertNoGeneratedOutputs(cwd);
  }
});

test('bundled prebuild rejects representative invalid envelope and slug inputs without outputs', async () => {
  for (const config of [
    { version: '9.9' },
    { version: '1.0', unknown_root: true },
    { version: '1.0', site: { title: 42 } },
  ]) {
    const { cwd, sourceDir } = await createSource(config);
    const result = runPrebuild(cwd, sourceDir, {}, bundledPrebuildScript);

    assert.notEqual(result.status, 0, JSON.stringify(config));
    await assertNoGeneratedOutputs(cwd);
  }

  const { cwd, sourceDir } = await createSource(undefined, {
    'invalid.md': [
      '---',
      'path: news!',
      '---',
      '# Invalid',
      '',
    ].join('\n'),
  });
  const result = runPrebuild(cwd, sourceDir, {}, bundledPrebuildScript);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /front matter path segment/);
  await assertNoGeneratedOutputs(cwd);
});

test('canonical config schema exposes the strict v1.0 envelope, file path, and menu URL contracts', async () => {
  const schema = JSON.parse(await fs.readFile(schemaPath, 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.$id, 'https://schemas.zeropress.dev/build-pages-config/v1.0/schema.json');
  assert.deepEqual(schema.required, ['version']);
  assert.equal(schema.properties.version.const, '1.0');
  assert.equal(schema.properties.$schema.type, 'string');
  assert.equal(schema.$defs.menu.additionalProperties, false);
  assert.equal(schema.$defs.menuItem.additionalProperties, false);
  assert.equal(Object.hasOwn(schema.$defs.menuItem.properties, 'type'), false);
  assert.equal(schema.$defs.collection.additionalProperties, false);
  assert.equal(schema.$defs.menuItem.properties.url.$ref, '#/$defs/menuUrl');
  assert.equal(schema.$defs.siteLogo.properties.src.$ref, '#/$defs/mediaUrl');
  assert.match(schema.properties.site.$ref, /site/);
  assert.match(schema.$defs.site.properties.url['x-zeropress-runtime-url-validation'], /WHATWG URL parsing/);
  assert.match(schema.$defs.siteLogo.properties.src['x-zeropress-runtime-url-validation'], /WHATWG URL parsing/);
  assert.match(schema.$defs.menuUrl['x-zeropress-runtime-url-validation'], /WHATWG URL parsing/);
  assert.match(schema.$defs.customHtml.description, /65,536 Unicode code points/);
  assert.match(schema.$defs.customHtmlSlot.properties.file.description, /raw content is preserved/);

  const sourcePathPattern = new RegExp(schema.$defs.sourceFilePath.pattern, 'u');
  assert.equal(sourcePathPattern.test('guides/index.md'), true);
  assert.equal(sourcePathPattern.test(' guides/index.md'), false);
  assert.equal(sourcePathPattern.test('guides\\index.md'), false);
  assert.equal(sourcePathPattern.test('guides//index.md'), false);
  assert.equal(sourcePathPattern.test('guides/line\u0000break.md'), false);

  const rootRelativeMenuUrlPattern = new RegExp(schema.$defs.menuUrl.anyOf[1].pattern, 'u');
  assert.equal(rootRelativeMenuUrlPattern.test('/guide?mode=full#top'), true);
  assert.equal(rootRelativeMenuUrlPattern.test('../guide?mode=full#top'), false);
  assert.equal(rootRelativeMenuUrlPattern.test('foo/../bar'), false);
  assert.equal(rootRelativeMenuUrlPattern.test('?mode=full'), false);
  assert.equal(rootRelativeMenuUrlPattern.test('//example.com/docs'), false);
  assert.equal(rootRelativeMenuUrlPattern.test('/../'), false);
  assert.equal(rootRelativeMenuUrlPattern.test('/guide/\u0085child'), false);
  assert.equal(rootRelativeMenuUrlPattern.test('/guide/%ZZ'), false);

  const absoluteMediaUrlPatterns = schema.$defs.mediaUrl.anyOf[0].allOf.map(
    (entry) => new RegExp(entry.pattern || schema.$defs.absoluteWebUrl.pattern, 'u'),
  );
  const rootRelativeMediaUrlPattern = new RegExp(schema.$defs.mediaUrl.anyOf[1].pattern, 'u');
  const matchesMediaUrlSchema = (value) => (
    rootRelativeMediaUrlPattern.test(value)
    || absoluteMediaUrlPatterns.every((pattern) => pattern.test(value))
  );
  for (const value of [
    '/logo.svg',
    '/assets/logo.svg?v=2#brand',
    'https://example.com/logo.svg',
    'https://example.com/assets/logo.svg?v=2#brand',
  ]) {
    assert.equal(matchesMediaUrlSchema(value), true, value);
  }
  for (const value of [
    '/',
    '//example.com/logo.svg',
    './logo.svg',
    'https://example.com',
    'https://user@example.com/logo.svg',
    '/assets/../logo.svg',
    'https://example.com/assets/../logo.svg',
    '/logo %20.svg',
    '/logo-%ZZ.svg',
  ]) {
    assert.equal(matchesMediaUrlSchema(value), false, value);
  }
});

test('historical v0.1 config schema remains byte-identical', async () => {
  const historicalSchema = await fs.readFile(historicalSchemaPath);
  assert.equal(createHash('sha256').update(historicalSchema).digest('hex'), HISTORICAL_SCHEMA_SHA256);
});

test('v1.0 config schema is strict while the historical v0.1 schema remains an independent contract', async () => {
  const canonicalSchema = JSON.parse(await fs.readFile(schemaPath, 'utf8'));
  const historicalSchema = JSON.parse(await fs.readFile(historicalSchemaPath, 'utf8'));
  assert.deepEqual(canonicalSchema.required, ['version']);
  assert.equal(canonicalSchema.properties.version.const, '1.0');
  assert.equal(canonicalSchema.$defs.site.properties.indexing, undefined);
  assert.equal(canonicalSchema.$defs.site.properties.robots.$ref, '#/$defs/siteRobots');
  assert.equal(historicalSchema.required, undefined);
  assert.equal(historicalSchema.properties.version.const, '0.1');
  assert.equal(historicalSchema.$defs.site.properties.indexing.type, 'boolean');
});

test('an authored config must declare its version', async () => {
  for (const scriptPath of [prebuildScript, bundledPrebuildScript]) {
    const source = await createSource({ site: { title: 'Unversioned docs' } });
    const result = runPrebuild(source.cwd, source.sourceDir, {}, scriptPath);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /version is required in an authored Build Pages config/);
    await assertNoGeneratedOutputs(source.cwd);
  }
});

test('earlier Build Pages config versions are rejected without compatibility fallback', async () => {
  for (const scriptPath of [prebuildScript, bundledPrebuildScript]) {
    for (const version of ['0.1', '0.7']) {
      const source = await createSource({ version });
      const result = runPrebuild(source.cwd, source.sourceDir, {}, scriptPath);

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /version must be exactly "1\.0"/);
      await assertNoGeneratedOutputs(source.cwd);
    }
  }
});

test('materializes documented menu and collection fallbacks', async () => {
  const omittedSource = await createSource({
    version: '1.0',
    front_page: { type: 'markdown' },
  });
  const omittedResult = runPrebuild(omittedSource.cwd, omittedSource.sourceDir);
  assert.equal(omittedResult.status, 0, omittedResult.stderr);
  const omittedResolved = await readGeneratedJson(omittedSource.cwd, 'build-pages-config.json');
  assert.deepEqual(omittedResolved.menus, {
    primary: {
      name: 'Primary Menu',
      items: [{ title: 'Home', url: '/', target: '_self', children: [] }],
    },
  });
  assert.equal(Object.hasOwn(omittedResolved, 'collections'), false);

  const explicitSource = await createSource({
    version: '1.0',
    front_page: { type: 'markdown' },
    menus: {
      secondary: { items: [] },
    },
    collections: {
      docs: { items: ['index.md'] },
    },
  });
  const explicitResult = runPrebuild(explicitSource.cwd, explicitSource.sourceDir);
  assert.equal(explicitResult.status, 0, explicitResult.stderr);
  const explicitResolved = await readGeneratedJson(explicitSource.cwd, 'build-pages-config.json');
  const explicitPreview = await readGeneratedJson(explicitSource.cwd, 'preview-data.json');
  assert.deepEqual(explicitResolved.menus, {
    secondary: { name: 'secondary', items: [] },
  });
  assert.equal(explicitResolved.collections.docs.title, 'docs');
  assert.equal(explicitPreview.collections.docs.title, 'docs');

  const optOutSource = await createSource({
    version: '1.0',
    front_page: { type: 'markdown' },
    menus: {},
    collections: {},
  });
  const optOutResult = runPrebuild(optOutSource.cwd, optOutSource.sourceDir);
  assert.equal(optOutResult.status, 0, optOutResult.stderr);
  const optOutResolved = await readGeneratedJson(optOutSource.cwd, 'build-pages-config.json');
  assert.deepEqual(optOutResolved.menus, {});
  assert.equal(Object.hasOwn(optOutResolved, 'collections'), false);
});

async function createSource(config, extraFiles = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-config-contract-'));
  const sourceDir = path.join(cwd, 'docs');
  await fs.mkdir(path.join(sourceDir, '.zeropress'), { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'index.md'), '# Home\n', 'utf8');
  for (const [relativePath, content] of Object.entries(extraFiles)) {
    const filePath = path.join(sourceDir, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');
  }
  if (config !== undefined) {
    await fs.writeFile(
      path.join(sourceDir, '.zeropress', 'config.json'),
      `${JSON.stringify(config, null, 2)}\n`,
      'utf8',
    );
  }
  return { cwd, sourceDir };
}

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

async function readGeneratedJson(cwd, filename) {
  return JSON.parse(await fs.readFile(path.join(cwd, '.zeropress-build-pages', filename), 'utf8'));
}

async function assertNoGeneratedOutputs(cwd) {
  await assert.rejects(
    fs.access(path.join(cwd, '.zeropress-build-pages')),
    { code: 'ENOENT' },
  );
}
