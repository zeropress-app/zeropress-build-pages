import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, '..');
const prebuildScript = path.join(packageDir, 'src', 'prebuild.js');
const bundledPrebuildScript = path.join(packageDir, 'dist', 'prebuild.js');
const schemaPath = path.join(packageDir, 'schemas', 'zeropress-build-pages.config.v0.1.schema.json');

test('config envelope and nested config objects reject schema-invalid values before writing outputs', async () => {
  const cases = [
    [{ version: '9.9' }, /version must be exactly "0\.1"/],
    [{ version: 0.1 }, /version must be exactly "0\.1"/],
    [{ unknown_root: true }, /config contains unknown field "unknown_root"/],
    [{ $schema: 42 }, /\$schema must be a string/],
    [{ site: { title: 42 } }, /site\.title must be a non-empty string/],
    [{ site: { description: 42 } }, /site\.description must be a string/],
    [{ site: { url: 'https:\\example.com' } }, /site\.url must be an absolute http: or https: URL/],
    [{ site: { url: 'https://example.com:' } }, /site\.url must be an absolute http: or https: URL/],
    [{ site: { url: 'https://@example.com' } }, /site\.url must be an absolute http: or https: URL/],
    [{ site: { url: 'https://example.com:99999' } }, /site\.url must be an absolute http: or https: URL/],
    [{ site: { locale: 'x' } }, /site\.locale must be a non-empty locale string/],
    [{ site: { locale: '😀' } }, /site\.locale must be a non-empty locale string/],
    [{ site: { locale: ' en-US ' } }, /site\.locale must be a non-empty locale string/],
    [{ site: { logo: { src: ' /logo.svg' } } }, /site\.logo\.src must not contain leading or trailing whitespace/],
    [{ site: { logo: { src: '/logo mark.svg' } } }, /site\.logo\.src contains an unsafe or malformed URL character/],
    [{ site: { logo: { src: '/logo-%ZZ.svg' } } }, /site\.logo\.src contains an unsafe or malformed URL character/],
    [{ site: { logo: { src: 'https://example.com:' } } }, /site\.logo\.src must be a root-relative URL path/],
    [{ site: { logo: { src: 'https://@example.com/logo.svg' } } }, /site\.logo\.src must be a root-relative URL path/],
    [{ site: { logo: { src: 'https://example.com:99999/logo.svg' } } }, /site\.logo\.src must be a root-relative URL path/],
    [{ site: { footer: { copyright_text: '' } } }, /site\.footer\.copyright_text must be a non-empty string/],
    [{ site: { footer: { extra: true } } }, /site\.footer contains unknown field "extra"/],
    [{ menus: { Primary: { items: [] } } }, /menus\.Primary must use a lowercase config id/],
    [{ menus: { primary: { items: [], extra: true } } }, /menus\.primary contains unknown field "extra"/],
    [{ menus: { primary: { name: 42, items: [] } } }, /menus\.primary\.name must be a non-empty string/],
    [{ menus: { primary: { items: [{ title: 42, url: '/' }] } } }, /items\[0\]\.title must be a non-empty string/],
    [{ menus: { primary: { items: [{ title: 'Docs', url: '/', type: 'archive' }] } } }, /items\[0\]\.type must be one of/],
    [{ menus: { primary: { items: [{ title: 'Docs', url: '/', target: '_top' }] } } }, /items\[0\]\.target must be one of/],
    [{ menus: { primary: { items: [{ title: 'Docs', url: '/', children: {} }] } } }, /items\[0\]\.children must be an array/],
    [{ menus: { primary: { items: [{ title: 'Docs', url: '/', extra: true }] } } }, /items\[0\] contains unknown field "extra"/],
    [{ collections: { docs: { title: 42, items: [] } } }, /collections\.docs\.title must be a non-empty string/],
    [{ collections: { docs: { description: 42, items: [] } } }, /collections\.docs\.description must be a string/],
    [{ collections: { docs: { items: [], extra: true } } }, /collections\.docs contains unknown field "extra"/],
  ];

  for (const [config, expectedError] of cases) {
    const { cwd, sourceDir } = await createSource(config);
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
    const config = { version: '0.1', ...partialConfig };
    const { cwd, sourceDir } = await createSource(config);
    const result = runPrebuild(cwd, sourceDir);

    assert.notEqual(result.status, 0, JSON.stringify(config));
    assert.match(result.stderr, expectedError, JSON.stringify(config));
    await assertNoGeneratedOutputs(cwd);
  }
});

test('an environment site URL override does not mask an invalid configured site URL', async () => {
  const { cwd, sourceDir } = await createSource({
    version: '0.1',
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

test('menu URLs accept absolute HTTP(S) and path-bearing relative Web references', async () => {
  const urls = [
    '/',
    '/guide?mode=full#top',
    'guide',
    'guides/start?mode=full#top',
    './guide',
    '../guide',
    'foo/../bar',
    '/foo//bar',
    'https://example.com/docs/%E2%9C%93?q=ok#top',
    'https://user:pass@example.com/docs',
    'HTTP://example.com/docs',
  ];
  const config = {
    version: '0.1',
    menus: {
      primary: {
        items: urls.map((url, index) => ({ title: `Item ${index}`, url })),
      },
    },
  };
  const { cwd, sourceDir } = await createSource(config);
  const result = runPrebuild(cwd, sourceDir);

  assert.equal(result.status, 0, result.stderr);
  const previewData = JSON.parse(await fs.readFile(path.join(cwd, '.zeropress-build-page', 'preview-data.json'), 'utf8'));
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
      version: '0.1',
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
  const { cwd, sourceDir } = await createSource(undefined, {
    'Café Guide!.md': '# Café Guide\n',
    '문서_안내.md': '# 문서 안내\n',
    'explicit.md': [
      '---',
      'path: Cafe\u0301/설치_방법',
      '---',
      '# Explicit',
      '',
    ].join('\n'),
    [`${'a'.repeat(201)}.md`]: '# Long Filename\n',
  });
  const result = runPrebuild(cwd, sourceDir);

  assert.equal(result.status, 0, result.stderr);
  const previewData = JSON.parse(await fs.readFile(path.join(cwd, '.zeropress-build-page', 'preview-data.json'), 'utf8'));
  const pages = new Map(previewData.content.pages.map((page) => [page.title, page]));
  assert.equal(pages.get('Café Guide').path, 'café-guide');
  assert.equal(pages.get('Café Guide').slug, 'café-guide');
  assert.equal(pages.get('문서 안내').path, '문서_안내');
  assert.equal(pages.get('문서 안내').slug, '문서_안내');
  assert.equal(pages.get('Explicit').path, 'Café/설치_방법');
  assert.equal(pages.get('Explicit').slug, 'café-설치_방법');
  assert.equal(Array.from(pages.get('Long Filename').path).length, 200);
  assert.equal(Array.from(pages.get('Long Filename').slug).length, 200);
});

test('explicit front matter routes reject disallowed and overlong slug segments', async () => {
  for (const routePath of ['news!', 'a'.repeat(201)]) {
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
    { version: '0.1', unknown_root: true },
    { version: '0.1', site: { title: 42 } },
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

test('bundled config schema exposes the strict envelope, file path, and menu URL contracts', async () => {
  const schema = JSON.parse(await fs.readFile(schemaPath, 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.version.const, '0.1');
  assert.equal(schema.properties.$schema.type, 'string');
  assert.equal(schema.$defs.menu.additionalProperties, false);
  assert.equal(schema.$defs.menuItem.additionalProperties, false);
  assert.equal(schema.$defs.collection.additionalProperties, false);
  assert.equal(schema.$defs.menuItem.properties.url.$ref, '#/$defs/menuUrl');
  assert.match(schema.properties.site.$ref, /site/);
  assert.match(schema.$defs.site.properties.url['x-zeropress-runtime-url-validation'], /WHATWG URL parsing/);
  assert.match(schema.$defs.siteLogo.properties.src['x-zeropress-runtime-url-validation'], /WHATWG URL parsing/);
  assert.match(schema.$defs.menuUrl['x-zeropress-runtime-url-validation'], /WHATWG URL parsing/);

  const sourcePathPattern = new RegExp(schema.$defs.sourceFilePath.pattern, 'u');
  assert.equal(sourcePathPattern.test('guides/index.md'), true);
  assert.equal(sourcePathPattern.test(' guides/index.md'), false);
  assert.equal(sourcePathPattern.test('guides\\index.md'), false);
  assert.equal(sourcePathPattern.test('guides//index.md'), false);

  const relativeMenuUrlPattern = new RegExp(schema.$defs.menuUrl.anyOf[1].pattern, 'u');
  assert.equal(relativeMenuUrlPattern.test('../guide?mode=full#top'), true);
  assert.equal(relativeMenuUrlPattern.test('foo/../bar'), true);
  assert.equal(relativeMenuUrlPattern.test('?mode=full'), false);
  assert.equal(relativeMenuUrlPattern.test('//example.com/docs'), false);
  assert.equal(relativeMenuUrlPattern.test('/../'), false);
  assert.equal(relativeMenuUrlPattern.test('guide/\u0085child'), false);
  assert.equal(relativeMenuUrlPattern.test('guide/%ZZ'), false);
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

async function assertNoGeneratedOutputs(cwd) {
  await assert.rejects(
    fs.access(path.join(cwd, '.zeropress-build-page')),
    { code: 'ENOENT' },
  );
}
