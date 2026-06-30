import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const rootDir = process.cwd();
const packageDir = path.resolve(__dirname, '..');
const sourceDir = resolveEnvPath(['ZEROPRESS_BUILD_PAGES_SOURCE'], 'docs');
const publicDir = resolveEnvPath(['ZEROPRESS_BUILD_PAGES_PUBLIC_DIR'], sourceDir);
const defaultConfigPath = path.join(sourceDir, '.zeropress', 'config.json');
const configPath = resolveOptionalEnvPath(['ZEROPRESS_BUILD_PAGES_CONFIG'], defaultConfigPath);
const outDir = path.join(rootDir, '.zeropress-build-page');
const buildPagesConfigPath = path.join(outDir, 'build-pages-config.json');
const previewDataPath = path.join(outDir, 'preview-data.json');
const buildReportPath = path.join(outDir, 'build-report.json');
const skipUntitledMarkdown = readBooleanEnv('ZEROPRESS_SKIP_UNTITLED_MARKDOWN');
const copyMarkdownSource = readBooleanEnv('ZEROPRESS_COPY_MARKDOWN_SOURCE', true);
const themeId = readEnv('ZEROPRESS_BUILD_PAGES_THEME_ID', '');
const FRONT_PAGE_TYPES = new Set(['theme_index', 'markdown', 'html']);
const BUILD_PAGES_CONFIG_SCHEMA_URL = 'https://schemas.zeropress.dev/build-pages-config/v0.1/schema.json';
const PREVIEW_DATA_SCHEMA_URL = 'https://schemas.zeropress.dev/preview-data/v0.6/schema.json';
const FRONT_MATTER_DATA_KEY_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*(?:-[a-zA-Z0-9_]+)*$/;
const FRONT_MATTER_DATA_MAX_DEPTH = 4;
const FRONT_MATTER_DATA_MAX_KEYS = 64;
const FRONT_MATTER_DATA_MAX_ARRAY_LENGTH = 256;
const FRONT_MATTER_DISCOVERABILITY_VALUES = new Set(['default', 'noindex', 'delist']);
const MARKDOWN_UPDATED_AT_VALUES = new Set(['none', 'git']);
const MARKDOWN_LINK_OUTPUT_VALUES = new Set(['clean', 'html']);
const FEATURED_IMAGE_PROTOCOLS = new Set(['http:', 'https:']);
const CONFIG_REFERENCE_URL = 'https://build-pages.zeropress.dev/reference/config/';
const markdownDiscoverExcludeRoots = buildMarkdownDiscoverExcludeRoots();
let configFound = false;

class PrebuildMarkdownError extends Error {
  constructor(sourcePath, reason, expected = '', code = 'invalid_markdown') {
    super(reason);
    this.name = 'PrebuildMarkdownError';
    this.sourcePath = sourcePath;
    this.reason = reason;
    this.expected = expected;
    this.code = code;
  }
}

class PrebuildConfigError extends Error {
  constructor(reason, expected = '') {
    super(reason);
    this.name = 'PrebuildConfigError';
    this.reason = reason;
    this.expected = expected;
  }
}

main().catch(handlePrebuildError);

async function main() {
  const packageJson = await readPackageJson();
  const config = await loadPrebuildConfig();
  const frontPageConfig = await normalizeDefaultFrontPageConfig(
    normalizeFrontPageConfig(config.front_page),
    config.front_page,
  );
  const menus = normalizeMenus(config.menus);
  const customHtmlConfig = normalizeCustomHtmlConfig(config.custom_html);
  const markdownConfig = normalizeMarkdownConfig(config.markdown);
  const resolvedConfig = buildResolvedConfig(config, {
    frontPageConfig,
    menus,
    customHtmlConfig,
    markdownConfig,
  });
  const sourceFiles = await listMarkdownFiles(sourceDir);
  const skippedMarkdown = [];
  const pageInputs = [];

  for (const sourcePath of sourceFiles) {
    const rawMarkdown = await fs.readFile(sourcePath, 'utf8');
    const parsedMarkdown = parseMarkdownSource(rawMarkdown, sourcePath);
    const frontMatterStatus = readFrontMatterStatus(parsedMarkdown.frontMatter.status, sourcePath);
    if (frontMatterStatus !== 'published') {
      recordSkippedMarkdown(skippedMarkdown, sourcePath, frontMatterStatus.reason);
      if (frontMatterStatus.warning) {
        console.warn(formatSkippedMarkdownWarning(sourcePath, frontMatterStatus.reason, frontMatterStatus.expected));
      }
      continue;
    }

    const frontMatter = normalizePublishedFrontMatter(parsedMarkdown.frontMatter, sourcePath);
    const title = extractTitleOrSkip(parsedMarkdown.bodyMarkdown, sourcePath, skippedMarkdown, frontMatter.title);
    if (!title) {
      continue;
    }

    pageInputs.push({
      sourcePath,
      bodyMarkdown: parsedMarkdown.bodyMarkdown,
      frontMatter,
      title,
      route: buildPageRoute(sourcePath, {
        allowRootIndex: shouldAllowRootMarkdownIndex(frontPageConfig),
        routePath: frontMatter.path,
      }),
    });
  }

  const routeBySourcePath = new Map(
    pageInputs.map(({ sourcePath, route }) => [sourcePath, route]),
  );
  const publicAssetUrls = await buildPublicAssetUrlMap(publicDir);
  const collections = normalizeCollections(config.collections, pageInputs, skippedMarkdown);
  if (Object.keys(collections).length > 0) {
    resolvedConfig.collections = collections;
  }

  const pages = [];
  for (const { sourcePath, bodyMarkdown, frontMatter, title, route } of pageInputs) {
    const updatedAtIso = await buildPageUpdatedAtIso(sourcePath, frontMatter, markdownConfig);
    const featuredImage = buildPageFeaturedImageUrl(
      frontMatter.featured_image,
      sourcePath,
      resolvedConfig.site.url,
      publicAssetUrls,
    );
    pages.push({
      title,
      slug: route.slug,
      path: route.path,
      ...(updatedAtIso ? { updated_at_iso: updatedAtIso } : {}),
      ...(featuredImage ? { featured_image: featuredImage } : {}),
      meta: {
        ...frontMatter.meta,
        ...(copyMarkdownSource ? { source_markdown_url: buildSourceMarkdownUrl(sourcePath) } : {}),
      },
      ...(frontMatter.data !== undefined ? { data: frontMatter.data } : {}),
      ...(frontMatter.discoverability !== 'default' ? { discoverability: frontMatter.discoverability } : {}),
      content: rewriteMarkdownLinks(bodyMarkdown, sourcePath, routeBySourcePath, markdownConfig.link_output, publicAssetUrls),
      document_type: 'markdown',
      excerpt: frontMatter.description !== undefined
        ? frontMatter.description
        : extractExcerpt(bodyMarkdown, title),
      status: 'published',
    });
  }

  const frontPageResult = await buildFrontPageData(frontPageConfig, pageInputs, resolvedConfig);
  if (frontPageResult.page) {
    pages.push(frontPageResult.page);
  }

  const site = buildSiteData(resolvedConfig, frontPageResult.frontPage);
  const customHtml = await buildCustomHtmlData(customHtmlConfig);

  const previewData = {
    $schema: PREVIEW_DATA_SCHEMA_URL,
    version: '0.6',
    generator: 'zeropress-build-pages',
    generated_at: new Date().toISOString(),
    site,
    content: {
      authors: [],
      posts: [],
      pages,
      categories: [],
      tags: [],
    },
    menus,
    widgets: {},
  };

  if (Object.keys(collections).length > 0) {
    previewData.collections = collections;
  }
  if (customHtml) {
    previewData.custom_html = customHtml;
  }

  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(buildPagesConfigPath, `${JSON.stringify(resolvedConfig, null, 2)}\n`, 'utf8');
  await fs.writeFile(previewDataPath, `${JSON.stringify(previewData, null, 2)}\n`, 'utf8');

  const report = buildPrebuildReport({
    packageJson,
    sourceFiles,
    pageInputs,
    pages,
    skippedMarkdown,
    frontPageConfig,
    frontPage: frontPageResult.frontPage,
    customHtml,
  });
  await fs.writeFile(buildReportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(`Wrote ${path.relative(rootDir, previewDataPath)} with ${pages.length} pages`);
  printPrebuildSummary(report);
}

function handlePrebuildError(error) {
  if (error instanceof PrebuildMarkdownError) {
    console.error(formatMarkdownError(error));
    process.exitCode = 1;
    return;
  }

  if (error instanceof PrebuildConfigError) {
    console.error(formatConfigError(error));
    process.exitCode = 1;
    return;
  }

  const reason = error instanceof Error ? error.message : String(error);
  console.error(`[zeropress-build-pages] Unexpected prebuild failure.\nReason: ${reason}`);
  process.exitCode = 1;
}

function formatMarkdownError(error) {
  const lines = [
    `[zeropress-build-pages] Invalid Markdown page: ${formatSourcePath(error.sourcePath)}`,
    `Reason: ${error.reason}`,
  ];

  if (error.expected) {
    lines.push(`Expected one of:\n${error.expected}`);
  }

  return lines.join('\n');
}

function formatConfigError(error) {
  const lines = [
    `[zeropress-build-pages] Invalid site config: ${formatSourcePath(configPath)}`,
    `Reason: ${error.reason}`,
  ];

  if (error.expected) {
    lines.push(`Expected:\n${error.expected}`);
  }

  return lines.join('\n');
}

async function loadPrebuildConfig() {
  try {
    const rawConfig = await fs.readFile(configPath, 'utf8');
    configFound = true;
    const parsed = JSON.parse(rawConfig);
    if (!isPlainObject(parsed)) {
      throw new PrebuildConfigError('config.json must contain a JSON object.');
    }
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      configFound = false;
      return {};
    }
    if (error instanceof SyntaxError) {
      throw new PrebuildConfigError(`config.json is not valid JSON: ${error.message}`);
    }
    throw error;
  }
}

async function readPackageJson() {
  return JSON.parse(await fs.readFile(path.join(packageDir, 'package.json'), 'utf8'));
}

function buildSiteData(config, frontPage) {
  const configuredSite = isPlainObject(config.site) ? config.site : normalizeSiteConfig(undefined);

  const site = {
    title: configuredSite.title,
    description: configuredSite.description,
    url: configuredSite.url,
    media_base_url: '',
    locale: configuredSite.locale,
    posts_per_page: 10,
    datetime_display: 'static',
    date_style: 'medium',
    time_style: 'none',
    timezone: 'UTC',
    permalinks: defaultPermalinks(),
    front_page: frontPage,
    post_index: {
      enabled: false,
    },
    disallow_comments: true,
    expose_generator: configuredSite.expose_generator !== false,
    search: configuredSite.search !== false,
    indexing: configuredSite.indexing !== false,
  };

  if (configuredSite.logo) {
    site.logo = configuredSite.logo;
  }

  if (configuredSite.meta !== undefined) {
    site.meta = configuredSite.meta;
  }

  if (configuredSite.footer) {
    site.footer = configuredSite.footer;
  }

  return site;
}

function buildResolvedConfig(config, { frontPageConfig, menus, customHtmlConfig, markdownConfig }) {
  const resolvedConfig = {
    $schema: BUILD_PAGES_CONFIG_SCHEMA_URL,
    version: '0.1',
    site: normalizeSiteConfig(config.site),
    markdown: markdownConfig,
    front_page: frontPageConfig,
    menus,
  };

  if (customHtmlConfig) {
    resolvedConfig.custom_html = customHtmlConfig;
  }

  return resolvedConfig;
}

function normalizeMarkdownConfig(value) {
  if (value === undefined) {
    return {
      updated_at: 'none',
      link_output: 'clean',
    };
  }
  if (!isPlainObject(value)) {
    throw new PrebuildConfigError(
      'markdown must be an object.',
      '  "markdown": { "updated_at": "git", "link_output": "clean" }',
    );
  }
  assertKnownConfigKeys(value, ['updated_at', 'link_output'], 'markdown');

  return {
    updated_at: normalizeUpdatedAtPolicy(value.updated_at, 'markdown.updated_at'),
    link_output: normalizeMarkdownLinkOutput(value.link_output, 'markdown.link_output'),
  };
}

function normalizeSiteConfig(value) {
  if (value !== undefined && !isPlainObject(value)) {
    throw new PrebuildConfigError(
      'site must be an object.',
      '  "site": { "title": "My Docs", "description": "Project documentation" }',
    );
  }

  const configuredSite = isPlainObject(value) ? value : {};
  assertKnownConfigKeys(configuredSite, ['title', 'description', 'url', 'logo', 'locale', 'expose_generator', 'search', 'indexing', 'footer', 'meta'], 'site');
  const site = {
    title: readConfigString(configuredSite.title, 'Documentation'),
    description: readConfigString(configuredSite.description, ''),
    url: readEnv('ZEROPRESS_SITE_URL', readConfigString(configuredSite.url, '')),
    locale: normalizeSiteLocale(configuredSite.locale),
    expose_generator: readConfigBoolean(configuredSite.expose_generator, true, 'site.expose_generator'),
    search: readConfigBoolean(configuredSite.search, true, 'site.search'),
    indexing: readConfigBoolean(configuredSite.indexing, true, 'site.indexing'),
  };

  const logo = normalizeSiteLogo(configuredSite.logo);
  if (logo) {
    site.logo = logo;
  }

  const footer = normalizeFooter(configuredSite.footer);
  if (footer) {
    site.footer = footer;
  }

  if (configuredSite.meta !== undefined) {
    site.meta = normalizeSiteMeta(configuredSite.meta, 'site.meta');
  }

  return site;
}

function normalizeSiteLocale(value) {
  if (value === undefined) {
    return 'en-US';
  }
  if (typeof value !== 'string') {
    throw new PrebuildConfigError('site.locale must be a string when provided.');
  }

  const locale = value.trim();
  if (locale.length < 2) {
    throw new PrebuildConfigError('site.locale must be a non-empty locale string such as "en-US" or "ko-KR".');
  }

  return locale;
}

function normalizeSiteLogo(value) {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    throw new PrebuildConfigError('site.logo must be an object when provided.');
  }
  assertKnownConfigKeys(value, ['src', 'alt'], 'site.logo');

  const src = readConfigString(value.src, '');
  if (!src) {
    throw new PrebuildConfigError(
      'site.logo.src must be a non-empty URL-like string.',
      '  "logo": { "src": "/logo.svg", "alt": "My Site" }',
    );
  }
  validateUrlLikeString(src, 'site.logo.src');

  const logo = { src };
  if (value.alt !== undefined) {
    if (typeof value.alt !== 'string') {
      throw new PrebuildConfigError('site.logo.alt must be a string when provided.');
    }
    const alt = value.alt.trim();
    if (alt) {
      logo.alt = alt;
    }
  }

  return logo;
}

function normalizeSiteMeta(value, pathLabel) {
  if (!isPlainObject(value)) {
    throw new PrebuildConfigError(`${pathLabel} must be an object when provided.`);
  }

  const meta = {};
  for (const [key, metaValue] of Object.entries(value)) {
    if (!isPreviewMetaValue(metaValue)) {
      throw new PrebuildConfigError(`${pathLabel}.${key} must be a string, number, boolean, or null.`);
    }
    meta[key] = metaValue;
  }

  return meta;
}

function normalizeFooter(value) {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    throw new PrebuildConfigError('site.footer must be an object.');
  }
  assertKnownConfigKeys(value, ['copyright_text', 'attribution'], 'site.footer');

  const footer = {};
  const copyrightText = readConfigString(value.copyright_text, '');
  if (copyrightText) {
    footer.copyright_text = copyrightText;
  }

  if (value.attribution !== undefined) {
    if (typeof value.attribution !== 'boolean') {
      throw new PrebuildConfigError('site.footer.attribution must be a boolean when provided.');
    }
    footer.attribution = value.attribution;
  }

  return Object.keys(footer).length ? footer : undefined;
}

function validateUrlLikeString(value, pathLabel) {
  if (value.startsWith('//')) {
    throw new PrebuildConfigError(`${pathLabel} must be an absolute URL or a URL path starting with /, ./, or ../. Config-relative file lookup is not performed.`);
  }

  if (value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) {
    return;
  }

  try {
    const url = new URL(value);
    if (!url.protocol || !url.hostname) {
      throw new Error('missing host');
    }
  } catch {
    throw new PrebuildConfigError(`${pathLabel} must be an absolute URL or a URL path starting with /, ./, or ../. Config-relative file lookup is not performed.`);
  }
}

function readConfigBoolean(value, fallback, pathName) {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'boolean') {
    throw new PrebuildConfigError(`${pathName} must be a boolean when provided.`);
  }
  return value;
}

async function buildFrontPageData(frontPageConfig, pageInputs, config) {
  if (frontPageConfig.type === 'theme_index') {
    return {
      frontPage: {
        type: 'theme_index',
      },
    };
  }

  if (frontPageConfig.type === 'markdown') {
    const sourcePath = resolveConfiguredSourceFile(frontPageConfig.file, '.md', 'front_page.file');
    const matchedPage = pageInputs.find((pageInput) => pageInput.sourcePath === sourcePath);
    if (!matchedPage) {
      throw new PrebuildConfigError(
        `front_page.file was not discovered as a Markdown page: ${formatSourcePath(sourcePath)}`,
        '  "front_page": { "type": "markdown", "file": "index.md" }',
      );
    }
    assertUniquePageSlug(pageInputs, matchedPage.route.slug, sourcePath);

    return {
      frontPage: {
        type: 'page',
        page_slug: matchedPage.route.slug,
      },
    };
  }

  const sourcePath = resolveConfiguredSourceFile(frontPageConfig.file, '.html', 'front_page.file');
  const html = await readRequiredSourceFile(sourcePath, 'front_page.file');

  if (frontPageConfig.layout === false) {
    return {
      frontPage: {
        type: 'standalone_html',
        html,
      },
    };
  }

  const route = buildHtmlPageRoute(sourcePath, { allowRootIndex: true });
  assertNoPageSlugConflict(pageInputs, route.slug, sourcePath);

  return {
    frontPage: {
      type: 'page',
      page_slug: route.slug,
    },
    page: {
      title: readConfigString(config.site?.title, 'Home'),
      slug: route.slug,
      path: route.path,
      content: html,
      document_type: 'html',
      excerpt: extractHtmlExcerpt(html) || readConfigString(config.site?.description, ''),
      status: 'published',
    },
  };
}

function normalizeFrontPageConfig(value) {
  if (value === undefined) {
    return {
      type: 'theme_index',
    };
  }
  if (!isPlainObject(value)) {
    throw new PrebuildConfigError(
      'front_page must be an object.',
      '  "front_page": { "type": "theme_index" }',
    );
  }
  const type = value.type;
  if (typeof type !== 'string' || !FRONT_PAGE_TYPES.has(type)) {
    throw new PrebuildConfigError(
      'front_page.type must be one of "theme_index", "markdown", or "html".',
      '  "front_page": { "type": "theme_index" }\n  "front_page": { "type": "markdown" }\n  "front_page": { "type": "html" }',
    );
  }
  if (type === 'theme_index') {
    assertKnownConfigKeys(value, ['type'], 'front_page');
    return {
      type,
    };
  }
  assertKnownConfigKeys(
    value,
    type === 'html' ? ['type', 'file', 'layout'] : ['type', 'file'],
    'front_page',
  );
  if (value.layout !== undefined && typeof value.layout !== 'boolean') {
    throw new PrebuildConfigError('front_page.layout must be a boolean when provided.');
  }

  const file = normalizeSourceFilePath(defaultFrontPageFile(type, value.file), 'front_page.file');
  const expectedExtension = type === 'markdown' ? '.md' : '.html';
  if (!file.toLowerCase().endsWith(expectedExtension)) {
    throw new PrebuildConfigError(
      `front_page.file must end with ${expectedExtension} when front_page.type is "${type}".`,
      `  "front_page": { "type": "${type}", "file": "${type === 'markdown' ? 'index.md' : '.zeropress/index.html'}" }`,
    );
  }
  if (type === 'html' && !isZeropressHtmlFile(file)) {
    throw new PrebuildConfigError(
      'front_page.file must be an HTML file inside .zeropress/ when front_page.type is "html".',
      '  "front_page": { "type": "html", "file": ".zeropress/index.html" }\n  "front_page": { "type": "html", "file": ".zeropress/campaign.html", "layout": false }',
    );
  }

  const normalizedConfig = {
    type,
    file,
  };
  if (type === 'html') {
    normalizedConfig.layout = value.layout !== false;
  }

  return normalizedConfig;
}

async function normalizeDefaultFrontPageConfig(frontPageConfig, rawFrontPageConfig) {
  if (rawFrontPageConfig !== undefined || frontPageConfig.type !== 'theme_index') {
    return frontPageConfig;
  }

  try {
    const stat = await fs.stat(path.join(sourceDir, 'index.md'));
    if (stat.isFile()) {
      return {
        type: 'markdown',
        file: 'index.md',
      };
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  return frontPageConfig;
}

function defaultFrontPageFile(type, value) {
  if (value !== undefined) {
    return value;
  }
  return type === 'markdown' ? 'index.md' : '.zeropress/index.html';
}

function isZeropressHtmlFile(filePath) {
  return filePath.startsWith('.zeropress/') && filePath.toLowerCase().endsWith('.html');
}

function normalizeCustomHtmlConfig(value) {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    throw new PrebuildConfigError(
      'custom_html must be an object.',
      '  "custom_html": { "head_end": { "file": ".zeropress/head-end.html" } }',
    );
  }
  assertKnownConfigKeys(value, ['head_end', 'body_end'], 'custom_html');
  if (value.head_end === undefined && value.body_end === undefined) {
    throw new PrebuildConfigError(
      'custom_html must include head_end or body_end.',
      '  "custom_html": { "body_end": { "file": ".zeropress/body-end.html" } }',
    );
  }

  const customHtmlConfig = {};
  if (value.head_end !== undefined) {
    customHtmlConfig.head_end = normalizeCustomHtmlSlotConfig(value.head_end, 'custom_html.head_end');
  }
  if (value.body_end !== undefined) {
    customHtmlConfig.body_end = normalizeCustomHtmlSlotConfig(value.body_end, 'custom_html.body_end');
  }

  return customHtmlConfig;
}

function normalizeCustomHtmlSlotConfig(value, pathLabel) {
  if (!isPlainObject(value)) {
    throw new PrebuildConfigError(`${pathLabel} must be an object.`);
  }
  assertKnownConfigKeys(value, ['file'], pathLabel);
  if (value.file === undefined) {
    throw new PrebuildConfigError(
      `${pathLabel}.file is required.`,
      `  "${pathLabel.split('.').at(-1)}": { "file": ".zeropress/${pathLabel.endsWith('head_end') ? 'head-end' : 'body-end'}.html" }`,
    );
  }

  const file = normalizeSourceFilePath(value.file, `${pathLabel}.file`);
  if (!isZeropressHtmlFile(file)) {
    throw new PrebuildConfigError(
      `${pathLabel}.file must be an HTML file inside .zeropress/.`,
      `  "${pathLabel.split('.').at(-1)}": { "file": ".zeropress/${pathLabel.endsWith('head_end') ? 'head-end' : 'body-end'}.html" }`,
    );
  }

  return {
    file,
  };
}

async function buildCustomHtmlData(config) {
  if (!config) {
    return undefined;
  }

  const customHtml = {};
  if (config.head_end) {
    customHtml.head_end = await buildCustomHtmlSlotData(config.head_end, 'custom_html.head_end');
  }
  if (config.body_end) {
    customHtml.body_end = await buildCustomHtmlSlotData(config.body_end, 'custom_html.body_end');
  }

  return customHtml;
}

async function buildCustomHtmlSlotData(slotConfig, pathLabel) {
  const sourcePath = resolveConfiguredSourceFile(slotConfig.file, '.html', `${pathLabel}.file`);
  return {
    content: await readRequiredSourceFile(sourcePath, `${pathLabel}.file`),
  };
}

function customHtmlSlots(customHtml) {
  if (!customHtml) {
    return [];
  }
  return ['head_end', 'body_end'].filter((slot) => customHtml[slot]);
}

function assertKnownConfigKeys(value, allowedKeys, pathLabel) {
  const allowedKeySet = new Set(allowedKeys);
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeySet.has(key));
  if (unknownKeys.length) {
    throw new PrebuildConfigError(
      `${pathLabel} contains unknown field "${unknownKeys[0]}".`,
      `Allowed fields: ${allowedKeys.join(', ')}`,
    );
  }
}

function shouldAllowRootMarkdownIndex(frontPageConfig) {
  return frontPageConfig.type === 'markdown' && frontPageConfig.file === 'index.md';
}

function resolveConfiguredSourceFile(filePath, expectedExtension, pathLabel) {
  const normalizedPath = normalizeSourceFilePath(filePath, pathLabel);
  if (!normalizedPath.toLowerCase().endsWith(expectedExtension)) {
    throw new PrebuildConfigError(
      `${pathLabel} must end with ${expectedExtension}.`,
      `  "${pathLabel.split('.').at(-1)}": "index${expectedExtension}"`,
    );
  }

  const sourcePath = path.resolve(sourceDir, normalizedPath);
  if (!isPathInside(sourceDir, sourcePath)) {
    throw new PrebuildConfigError(`${pathLabel} must stay inside ${formatSourcePath(sourceDir)}.`);
  }

  return sourcePath;
}

function normalizeSourceFilePath(value, pathLabel) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new PrebuildConfigError(`${pathLabel} must be a non-empty string.`);
  }

  const normalizedPath = value.trim().replace(/\\/g, '/');
  const segments = normalizedPath.split('/');
  if (
    path.isAbsolute(normalizedPath)
    || normalizedPath.includes('?')
    || normalizedPath.includes('#')
    || segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new PrebuildConfigError(
      `${pathLabel} must be a safe source-root relative path.`,
      '  "front_page": { "type": "markdown", "file": "index.md" }\n  "front_page": { "type": "html", "file": ".zeropress/index.html", "layout": false }',
    );
  }

  return normalizedPath;
}

async function readRequiredSourceFile(sourcePath, pathLabel) {
  let content = '';
  try {
    content = await fs.readFile(sourcePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new PrebuildConfigError(`${pathLabel} does not exist: ${formatSourcePath(sourcePath)}`);
    }
    throw error;
  }

  if (!content.trim()) {
    throw new PrebuildConfigError(`${pathLabel} must not be empty: ${formatSourcePath(sourcePath)}`);
  }

  return content;
}

function assertUniquePageSlug(pageInputs, slug, sourcePath) {
  const matchingPages = pageInputs.filter((pageInput) => pageInput.route.slug === slug);
  if (matchingPages.length > 1) {
    throw new PrebuildConfigError(
      `front_page.file resolves to a duplicate page slug "${slug}": ${formatSourcePath(sourcePath)}`,
      'Choose a front page file whose generated slug is unique.',
    );
  }
}

function assertNoPageSlugConflict(pageInputs, slug, sourcePath) {
  const matchingPage = pageInputs.find((pageInput) => pageInput.route.slug === slug);
  if (matchingPage) {
    throw new PrebuildConfigError(
      `front_page.file resolves to page slug "${slug}", which conflicts with ${formatSourcePath(matchingPage.sourcePath)}.`,
      `Move or rename ${formatSourcePath(sourcePath)}, or choose a different front_page.file.`,
    );
  }
}

function isPathInside(parentPath, childPath) {
  const relativePath = path.relative(parentPath, childPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function defaultPermalinks() {
  return {
    output_style: 'html-extension',
    posts: '/posts/:slug/',
    pages: '/:slug/',
    categories: '/categories/:slug/',
    tags: '/tags/:slug/',
  };
}

function normalizeMenus(value) {
  if (value === undefined) {
    return defaultMenus();
  }
  if (!isPlainObject(value)) {
    throw new PrebuildConfigError('menus must be an object keyed by menu id.');
  }

  const menus = {};
  for (const [menuId, menu] of Object.entries(value)) {
    if (!isPlainObject(menu)) {
      throw new PrebuildConfigError(`menus.${menuId} must be an object.`);
    }
    if (!Array.isArray(menu.items)) {
      throw new PrebuildConfigError(`menus.${menuId}.items must be an array.`);
    }
    menus[menuId] = {
      name: readConfigString(menu.name, menuId),
      items: menu.items.map((item, index) => normalizeMenuItem(item, `menus.${menuId}.items[${index}]`)),
    };
  }

  return menus;
}

function normalizeMenuItem(item, pathLabel) {
  if (!isPlainObject(item)) {
    throw new PrebuildConfigError(`${pathLabel} must be an object.`);
  }
  const title = readConfigString(item.title, '');
  const url = readConfigString(item.url, '');
  if (!title || !url) {
    throw new PrebuildConfigError(`${pathLabel} must include non-empty title and url strings.`);
  }

  return {
    title,
    url,
    target: readConfigString(item.target, '_self'),
    ...(item.meta !== undefined ? { meta: normalizeMenuItemMeta(item.meta, `${pathLabel}.meta`) } : {}),
    children: Array.isArray(item.children)
      ? item.children.map((child, index) => normalizeMenuItem(child, `${pathLabel}.children[${index}]`))
      : [],
  };
}

function normalizeMenuItemMeta(value, pathLabel) {
  if (!isPlainObject(value)) {
    throw new PrebuildConfigError(`${pathLabel} must be an object when provided.`);
  }

  const meta = {};
  for (const [key, metaValue] of Object.entries(value)) {
    if (!isPreviewMetaValue(metaValue)) {
      throw new PrebuildConfigError(`${pathLabel}.${key} must be a string, number, boolean, or null.`);
    }
    meta[key] = metaValue;
  }

  return meta;
}

function defaultMenus() {
  return {
    primary: {
      name: 'Primary Menu',
      items: [
        menuItem('Home', '/'),
      ],
    },
  };
}

function normalizeCollections(value, pageInputs, skippedMarkdown) {
  if (value === undefined) {
    return {};
  }
  if (!isPlainObject(value)) {
    throw new PrebuildConfigError('collections must be an object keyed by collection id.');
  }

  const pageBySourcePath = new Map(pageInputs.map((pageInput) => [pageInput.sourcePath, pageInput]));
  const skippedByFile = new Map(
    skippedMarkdown.map((entry) => [path.resolve(rootDir, entry.file), entry.reason]),
  );
  const collections = {};

  for (const [collectionId, collection] of Object.entries(value)) {
    validateConfigId(collectionId, `collections.${collectionId}`);
    if (!isPlainObject(collection)) {
      throw new PrebuildConfigError(`collections.${collectionId} must be an object.`);
    }
    assertKnownConfigKeys(collection, ['title', 'description', 'items'], `collections.${collectionId}`);
    if (!Array.isArray(collection.items)) {
      throw new PrebuildConfigError(`collections.${collectionId}.items must be an array of Markdown source paths.`);
    }

    const seenSourcePaths = new Set();
    const items = collection.items.map((item, index) => {
      const pathLabel = `collections.${collectionId}.items[${index}]`;
      const normalizedPath = resolveCollectionSourcePath(item, pathLabel);
      const sourcePath = path.resolve(sourceDir, normalizedPath);
      if (seenSourcePaths.has(sourcePath)) {
        throw new PrebuildConfigError(`${pathLabel} duplicates ${normalizedPath} in collections.${collectionId}.`);
      }
      seenSourcePaths.add(sourcePath);

      const pageInput = pageBySourcePath.get(sourcePath);
      if (!pageInput) {
        const skippedReason = skippedByFile.get(sourcePath);
        if (skippedReason) {
          throw new PrebuildConfigError(`${pathLabel} references skipped Markdown ${normalizedPath}: ${skippedReason}`);
        }
        throw new PrebuildConfigError(`${pathLabel} was not discovered as a Markdown page: ${normalizedPath}`);
      }

      return {
        type: 'page',
        slug: pageInput.route.slug,
      };
    });

    collections[collectionId] = {
      title: readConfigString(collection.title, collectionId),
      ...(collection.description !== undefined ? { description: readConfigString(collection.description, '') } : {}),
      items,
    };
  }

  return collections;
}

function resolveCollectionSourcePath(value, pathLabel) {
  const normalizedPath = normalizeSourceFilePath(value, pathLabel);
  if (!normalizedPath.toLowerCase().endsWith('.md')) {
    throw new PrebuildConfigError(`${pathLabel} must be a Markdown source path ending in .md.`);
  }
  return normalizedPath;
}

function validateConfigId(value, pathLabel) {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(value)) {
    throw new PrebuildConfigError(`${pathLabel} must use a lowercase config id such as "docs" or "reference-guides".`);
  }
}

function buildPrebuildReport({
  packageJson,
  sourceFiles,
  pageInputs,
  pages,
  skippedMarkdown,
  frontPageConfig,
  frontPage,
  customHtml,
}) {
  return {
    generated_at: new Date().toISOString(),
    build_pages_version: packageJson.version,
    theme_id: themeId,
    source_dir: formatSourcePath(sourceDir),
    public_dir: formatSourcePath(publicDir),
    config_path: formatSourcePath(configPath),
    config_found: configFound,
    config_reference_url: CONFIG_REFERENCE_URL,
    build_pages_config_path: formatSourcePath(buildPagesConfigPath),
    preview_data_path: formatSourcePath(previewDataPath),
    report_path: formatSourcePath(buildReportPath),
    skip_untitled_markdown: skipUntitledMarkdown,
    copy_markdown_source: copyMarkdownSource,
    markdown: {
      discovered: sourceFiles.length,
      generated_pages: pageInputs.length,
      skipped: skippedMarkdown.length,
      skipped_files: skippedMarkdown,
    },
    pages: {
      total: pages.length,
    },
    front_page: {
      config: frontPageConfig,
      preview_data: frontPage,
    },
    custom_html: customHtmlSlots(customHtml),
  };
}

function printPrebuildSummary(report) {
  const lines = [
    'ZeroPress build report',
    `- Source root: ${report.source_dir}`,
    `- Public root: ${report.public_dir}`,
    `- Theme: ${report.theme_id || 'unknown'}`,
    `- Markdown discovered: ${report.markdown.discovered}`,
    `- Markdown pages generated: ${report.markdown.generated_pages}`,
    `- Markdown skipped: ${report.markdown.skipped}`,
    `- Total preview pages: ${report.pages.total}`,
    `- Source config: ${formatConfigSummary(report)}`,
    `- Config reference: ${report.config_reference_url}`,
    `- Resolved config: ${report.build_pages_config_path} (generated effective config)`,
    `- Front page: ${formatFrontPageSummary(report.front_page)}`,
    `- Custom HTML slots: ${report.custom_html.length ? report.custom_html.join(', ') : 'none'}`,
    `- Report: ${report.report_path}`,
  ];

  console.log(lines.join('\n'));
}

function formatConfigSummary(report) {
  if (report.config_found) {
    return report.config_path;
  }
  return `${report.config_path} (not found; using defaults)`;
}

function formatFrontPageSummary(frontPageReport) {
  const config = frontPageReport.config;
  const previewData = frontPageReport.preview_data;
  if (config.type === 'theme_index') {
    return 'theme_index -> /';
  }
  if (config.type === 'markdown') {
    return `markdown ${config.file} -> / (${previewData.page_slug})`;
  }
  if (previewData.type === 'standalone_html') {
    return `html ${config.file} -> / (standalone_html)`;
  }
  return `html ${config.file} -> / (${previewData.page_slug})`;
}

function parseMarkdownSource(rawMarkdown, sourcePath) {
  try {
    const parsed = parseYamlFrontMatter(rawMarkdown, sourcePath);
    if (!isPlainObject(parsed.data)) {
      throw new PrebuildMarkdownError(
        sourcePath,
        'front matter must be a YAML object.',
      );
    }

    return {
      bodyMarkdown: parsed.content,
      frontMatter: parsed.data,
    };
  } catch (error) {
    if (error instanceof PrebuildMarkdownError) {
      throw error;
    }

    throw new PrebuildMarkdownError(
      sourcePath,
      `invalid YAML front matter: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseYamlFrontMatter(rawMarkdown, sourcePath) {
  const input = rawMarkdown.startsWith('\uFEFF') ? rawMarkdown.slice(1) : rawMarkdown;
  const firstLine = readLine(input, 0);
  const firstLineText = firstLine.text.trim();

  if (firstLineText !== '---') {
    if (firstLineText.startsWith('---')) {
      throw new PrebuildMarkdownError(
        sourcePath,
        'front matter must use plain YAML delimiters. Language-specific front matter is not supported.',
        '  ---\n  title: My Page\n  ---',
      );
    }

    return {
      content: rawMarkdown,
      data: {},
    };
  }

  let cursor = firstLine.nextOffset;
  const matterStart = cursor;
  while (cursor <= input.length) {
    const line = readLine(input, cursor);
    if (line.text.trim() === '---') {
      return {
        content: input.slice(line.nextOffset),
        data: parseFrontMatterYamlBlock(input.slice(matterStart, line.startOffset), sourcePath),
      };
    }

    if (line.nextOffset <= cursor) {
      break;
    }
    cursor = line.nextOffset;
  }

  throw new PrebuildMarkdownError(
    sourcePath,
    'front matter opening delimiter is missing a closing delimiter.',
    '  ---\n  title: My Page\n  ---',
  );
}

function readLine(input, offset) {
  if (offset >= input.length) {
    return {
      startOffset: offset,
      text: '',
      nextOffset: input.length + 1,
    };
  }

  const newlineIndex = input.indexOf('\n', offset);
  const lineEnd = newlineIndex === -1 ? input.length : newlineIndex;
  const rawText = input.slice(offset, lineEnd);
  return {
    startOffset: offset,
    text: rawText.endsWith('\r') ? rawText.slice(0, -1) : rawText,
    nextOffset: newlineIndex === -1 ? input.length + 1 : newlineIndex + 1,
  };
}

function parseFrontMatterYamlBlock(block, sourcePath) {
  const lines = buildFrontMatterYamlLines(block, sourcePath);
  if (lines.length === 0) {
    return {};
  }
  if (lines[0].indent !== 0) {
    throw frontMatterYamlError(sourcePath, lines[0], 'root front matter keys must not be indented.');
  }

  const result = parseFrontMatterYamlBlockAt(lines, 0, 0, sourcePath);
  if (result.index < lines.length) {
    throw frontMatterYamlError(sourcePath, lines[result.index], 'unexpected YAML indentation.');
  }
  if (!isPlainObject(result.value)) {
    throw new PrebuildMarkdownError(
      sourcePath,
      'front matter must be a YAML object.',
    );
  }
  return result.value;
}

function buildFrontMatterYamlLines(block, sourcePath) {
  const rawLines = block.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const lines = [];

  rawLines.forEach((rawLine, index) => {
    if (/^\s*$/.test(rawLine) || /^\s*#/.test(rawLine)) {
      return;
    }
    const leadingWhitespace = rawLine.match(/^[ \t]*/)[0];
    if (leadingWhitespace.includes('\t')) {
      throw frontMatterYamlError(sourcePath, { lineNumber: index + 1 }, 'tabs are not allowed for YAML indentation.');
    }

    const indent = leadingWhitespace.length;
    const text = stripYamlInlineComment(rawLine.slice(indent)).trimEnd();
    if (!text) {
      return;
    }
    if (/^-\s+[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(text)) {
      lines.push({ indent, text: '-', lineNumber: index + 1 });
      lines.push({ indent: indent + 2, text: text.slice(1).trimStart(), lineNumber: index + 1 });
      return;
    }

    lines.push({ indent, text, lineNumber: index + 1 });
  });

  return lines;
}

function stripYamlInlineComment(text) {
  let quote = '';
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && character === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = '';
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '#' && (index === 0 || /\s/.test(text[index - 1]))) {
      return text.slice(0, index).trimEnd();
    }
  }
  return text;
}

function parseFrontMatterYamlBlockAt(lines, index, indent, sourcePath) {
  if (lines[index]?.text === '-' || lines[index]?.text.startsWith('- ')) {
    return parseFrontMatterYamlArray(lines, index, indent, sourcePath);
  }
  return parseFrontMatterYamlObject(lines, index, indent, sourcePath);
}

function parseFrontMatterYamlObject(lines, index, indent, sourcePath) {
  const object = {};
  while (index < lines.length) {
    const line = lines[index];
    if (line.indent < indent) {
      break;
    }
    if (line.indent > indent) {
      throw frontMatterYamlError(sourcePath, line, 'unexpected YAML indentation.');
    }
    if (line.text === '-' || line.text.startsWith('- ')) {
      break;
    }

    const pair = parseFrontMatterYamlPair(line.text, sourcePath, line);
    if (Object.hasOwn(object, pair.key)) {
      throw frontMatterYamlError(sourcePath, line, `duplicate YAML key "${pair.key}".`);
    }

    if (pair.valueText === '') {
      if (index + 1 < lines.length && lines[index + 1].indent > indent) {
        const child = parseFrontMatterYamlBlockAt(lines, index + 1, lines[index + 1].indent, sourcePath);
        object[pair.key] = child.value;
        index = child.index;
      } else {
        object[pair.key] = null;
        index += 1;
      }
    } else {
      object[pair.key] = parseFrontMatterYamlScalar(pair.valueText, sourcePath, line);
      index += 1;
    }
  }

  return { value: object, index };
}

function parseFrontMatterYamlArray(lines, index, indent, sourcePath) {
  const array = [];
  while (index < lines.length) {
    const line = lines[index];
    if (line.indent < indent) {
      break;
    }
    if (line.indent > indent) {
      throw frontMatterYamlError(sourcePath, line, 'unexpected YAML indentation.');
    }
    if (line.text !== '-' && !line.text.startsWith('- ')) {
      break;
    }

    const itemText = line.text === '-' ? '' : line.text.slice(1).trimStart();
    if (itemText === '') {
      if (index + 1 < lines.length && lines[index + 1].indent > indent) {
        const child = parseFrontMatterYamlBlockAt(lines, index + 1, lines[index + 1].indent, sourcePath);
        array.push(child.value);
        index = child.index;
      } else {
        array.push(null);
        index += 1;
      }
    } else {
      array.push(parseFrontMatterYamlScalar(itemText, sourcePath, line));
      index += 1;
      if (index < lines.length && lines[index].indent > indent) {
        throw frontMatterYamlError(sourcePath, lines[index], 'nested YAML content after a scalar list item is not supported.');
      }
    }
  }

  return { value: array, index };
}

function parseFrontMatterYamlPair(text, sourcePath, line) {
  const colonIndex = findYamlTopLevelColon(text);
  if (colonIndex <= 0) {
    throw frontMatterYamlError(sourcePath, line, 'expected a YAML key-value pair.');
  }

  const key = text.slice(0, colonIndex).trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(key)) {
    throw frontMatterYamlError(sourcePath, line, `unsupported YAML key "${key}".`);
  }

  return {
    key,
    valueText: text.slice(colonIndex + 1).trim(),
  };
}

function findYamlTopLevelColon(text) {
  let quote = '';
  let escaped = false;
  let squareDepth = 0;
  let braceDepth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && character === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = '';
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '[') {
      squareDepth += 1;
      continue;
    }
    if (character === ']') {
      squareDepth -= 1;
      continue;
    }
    if (character === '{') {
      braceDepth += 1;
      continue;
    }
    if (character === '}') {
      braceDepth -= 1;
      continue;
    }
    if (character === ':' && squareDepth === 0 && braceDepth === 0) {
      return index;
    }
  }
  return -1;
}

function parseFrontMatterYamlScalar(text, sourcePath, line) {
  if (text === '|' || text === '>') {
    throw frontMatterYamlError(sourcePath, line, 'block scalar front matter values are not supported.');
  }
  if (/^(?:!|&|\*)/.test(text)) {
    throw frontMatterYamlError(sourcePath, line, 'YAML tags, anchors, and aliases are not supported.');
  }
  if (text.startsWith('[')) {
    return parseFrontMatterYamlInlineArray(text, sourcePath, line);
  }
  if (text.startsWith('{')) {
    return parseFrontMatterYamlInlineObject(text, sourcePath, line);
  }
  if (text.startsWith('"')) {
    return parseYamlDoubleQuotedString(text, sourcePath, line);
  }
  if (text.startsWith("'")) {
    return parseYamlSingleQuotedString(text, sourcePath, line);
  }
  if (text === 'true') {
    return true;
  }
  if (text === 'false') {
    return false;
  }
  if (text === 'null' || text === '~') {
    return null;
  }
  if (/^[-+]?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?$/.test(text)) {
    const numberValue = Number(text);
    if (!Number.isFinite(numberValue)) {
      throw frontMatterYamlError(sourcePath, line, 'YAML number must be finite.');
    }
    return numberValue;
  }
  return text;
}

function parseYamlDoubleQuotedString(text, sourcePath, line) {
  if (!text.endsWith('"') || text.length === 1) {
    throw frontMatterYamlError(sourcePath, line, 'unterminated double-quoted YAML string.');
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw frontMatterYamlError(
      sourcePath,
      line,
      `invalid double-quoted YAML string: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseYamlSingleQuotedString(text, sourcePath, line) {
  if (!text.endsWith("'") || text.length === 1) {
    throw frontMatterYamlError(sourcePath, line, 'unterminated single-quoted YAML string.');
  }
  return text.slice(1, -1).replace(/''/g, "'");
}

function parseFrontMatterYamlInlineArray(text, sourcePath, line) {
  if (!text.endsWith(']')) {
    throw frontMatterYamlError(sourcePath, line, 'unterminated inline YAML array.');
  }
  const content = text.slice(1, -1).trim();
  if (!content) {
    return [];
  }
  return splitYamlInlineItems(content, sourcePath, line).map((item) => (
    parseFrontMatterYamlScalar(item, sourcePath, line)
  ));
}

function parseFrontMatterYamlInlineObject(text, sourcePath, line) {
  if (!text.endsWith('}')) {
    throw frontMatterYamlError(sourcePath, line, 'unterminated inline YAML object.');
  }
  const content = text.slice(1, -1).trim();
  if (!content) {
    return {};
  }

  const object = {};
  for (const item of splitYamlInlineItems(content, sourcePath, line)) {
    const pair = parseFrontMatterYamlPair(item, sourcePath, line);
    if (Object.hasOwn(object, pair.key)) {
      throw frontMatterYamlError(sourcePath, line, `duplicate YAML key "${pair.key}".`);
    }
    if (pair.valueText === '') {
      throw frontMatterYamlError(sourcePath, line, `inline YAML key "${pair.key}" must have a value.`);
    }
    object[pair.key] = parseFrontMatterYamlScalar(pair.valueText, sourcePath, line);
  }
  return object;
}

function splitYamlInlineItems(text, sourcePath, line) {
  const items = [];
  let quote = '';
  let escaped = false;
  let squareDepth = 0;
  let braceDepth = 0;
  let start = 0;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && character === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = '';
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '[') {
      squareDepth += 1;
      continue;
    }
    if (character === ']') {
      squareDepth -= 1;
      continue;
    }
    if (character === '{') {
      braceDepth += 1;
      continue;
    }
    if (character === '}') {
      braceDepth -= 1;
      continue;
    }
    if (character === ',' && squareDepth === 0 && braceDepth === 0) {
      const item = text.slice(start, index).trim();
      if (!item) {
        throw frontMatterYamlError(sourcePath, line, 'empty inline YAML item.');
      }
      items.push(item);
      start = index + 1;
    }
  }

  if (quote || squareDepth !== 0 || braceDepth !== 0) {
    throw frontMatterYamlError(sourcePath, line, 'unterminated inline YAML value.');
  }

  const item = text.slice(start).trim();
  if (!item) {
    throw frontMatterYamlError(sourcePath, line, 'empty inline YAML item.');
  }
  items.push(item);
  return items;
}

function frontMatterYamlError(sourcePath, line, reason) {
  const location = line?.lineNumber ? ` at front matter line ${line.lineNumber}` : '';
  return new PrebuildMarkdownError(
    sourcePath,
    `invalid YAML front matter${location}: ${reason}`,
  );
}

function readFrontMatterStatus(value, sourcePath) {
  if (value === undefined || value === 'published') {
    return 'published';
  }
  if (value === 'draft') {
    return {
      reason: 'front matter status is "draft".',
    };
  }

  return {
    reason: `unsupported front matter status ${formatFrontMatterValue(value)}.`,
    expected: 'Expected status: published or draft.',
    warning: true,
  };
}

function normalizePublishedFrontMatter(frontMatter, sourcePath) {
  return {
    title: normalizeFrontMatterTitle(frontMatter.title, sourcePath),
    description: normalizeFrontMatterDescription(frontMatter.description, sourcePath),
    path: normalizeFrontMatterRoutePath(frontMatter.path, sourcePath),
    updated_at: normalizeFrontMatterUpdatedAt(frontMatter.updated_at, sourcePath),
    featured_image: normalizeFrontMatterFeaturedImage(frontMatter.featured_image, sourcePath),
    discoverability: normalizeFrontMatterDiscoverability(frontMatter.discoverability, sourcePath),
    meta: normalizeFrontMatterMeta(frontMatter.meta, sourcePath),
    data: normalizeFrontMatterData(frontMatter.data, sourcePath),
  };
}

function normalizeUpdatedAtPolicy(value, pathLabel) {
  if (value === undefined) {
    return 'none';
  }
  if (typeof value === 'string' && MARKDOWN_UPDATED_AT_VALUES.has(value)) {
    return value;
  }

  throw new PrebuildConfigError(
    `${pathLabel} must be one of: ${Array.from(MARKDOWN_UPDATED_AT_VALUES).join(', ')}.`,
    '  "markdown": { "updated_at": "none" }\n  "markdown": { "updated_at": "git" }',
  );
}

function normalizeMarkdownLinkOutput(value, pathLabel) {
  if (value === undefined) {
    return 'clean';
  }
  if (typeof value === 'string' && MARKDOWN_LINK_OUTPUT_VALUES.has(value)) {
    return value;
  }

  throw new PrebuildConfigError(
    `${pathLabel} must be one of: ${Array.from(MARKDOWN_LINK_OUTPUT_VALUES).join(', ')}.`,
    '  "markdown": { "link_output": "clean" }\n  "markdown": { "link_output": "html" }',
  );
}

function normalizeFrontMatterUpdatedAt(value, sourcePath) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    const trimmedValue = value.trim();
    if (MARKDOWN_UPDATED_AT_VALUES.has(trimmedValue)) {
      return trimmedValue === 'none' ? null : trimmedValue;
    }
    if (isValidDateTimeString(trimmedValue)) {
      return trimmedValue;
    }
  }

  warnInvalidFrontMatterUpdatedAt(sourcePath, value);
  return null;
}

function normalizeFrontMatterFeaturedImage(value, sourcePath) {
  if (value === undefined) {
    return '';
  }
  if (typeof value !== 'string' || !value.trim()) {
    warnInvalidFrontMatterFeaturedImage(
      sourcePath,
      value,
      'featured_image must be a non-empty string.',
    );
    return '';
  }

  return value.trim();
}

function normalizeFrontMatterTitle(value, sourcePath) {
  if (value === undefined) {
    return '';
  }
  if (typeof value !== 'string' || !value.trim()) {
    throw new PrebuildMarkdownError(
      sourcePath,
      'front matter title must be a non-empty string when provided.',
    );
  }

  return value.trim();
}

function normalizeFrontMatterDescription(value, sourcePath) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new PrebuildMarkdownError(
      sourcePath,
      'front matter description must be a string when provided.',
    );
  }

  return value.trim();
}

function normalizeFrontMatterRoutePath(value, sourcePath) {
  if (value === undefined) {
    return '';
  }
  if (typeof value !== 'string' || !value.trim()) {
    throw new PrebuildMarkdownError(
      sourcePath,
      'front matter path must be a non-empty string when provided.',
    );
  }

  const routePath = value.trim();
  const segments = routePath.split('/');
  if (
    routePath.startsWith('/')
    || routePath.endsWith('/')
    || routePath.includes('\\')
    || routePath.includes('?')
    || routePath.includes('#')
    || segments.some((segment) => !isSafeRoutePathSegment(segment))
  ) {
    throw new PrebuildMarkdownError(
      sourcePath,
      'front matter path must be a safe generated route path.',
      '  path: guides/install\n  path: spec/preview-data-v0.6',
    );
  }

  return routePath;
}

function normalizeFrontMatterDiscoverability(value, sourcePath) {
  if (value === undefined) {
    return 'default';
  }
  if (typeof value === 'string' && FRONT_MATTER_DISCOVERABILITY_VALUES.has(value)) {
    return value;
  }

  throw new PrebuildMarkdownError(
    sourcePath,
    `front matter discoverability must be one of: ${Array.from(FRONT_MATTER_DISCOVERABILITY_VALUES).join(', ')}.`,
    '  discoverability: default\n  discoverability: noindex\n  discoverability: delist',
  );
}

function isSafeRoutePathSegment(segment) {
  return (
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(segment)
    && !segment.includes('..')
  );
}

function normalizeFrontMatterMeta(value, sourcePath) {
  if (value === undefined) {
    return {};
  }
  if (!isPlainObject(value)) {
    throw new PrebuildMarkdownError(
      sourcePath,
      'front matter meta must be an object when provided.',
    );
  }

  const meta = {};
  for (const [key, metaValue] of Object.entries(value)) {
    if (!isPreviewMetaValue(metaValue)) {
      throw new PrebuildMarkdownError(
        sourcePath,
        `front matter meta.${key} must be a string, number, boolean, or null.`,
      );
    }
    meta[key] = metaValue;
  }

  return meta;
}

async function buildPageUpdatedAtIso(sourcePath, frontMatter, markdownConfig) {
  if (frontMatter.updated_at === null) {
    return '';
  }
  if (typeof frontMatter.updated_at === 'string' && frontMatter.updated_at !== 'git') {
    return frontMatter.updated_at;
  }

  const updatedAtPolicy = frontMatter.updated_at || markdownConfig.updated_at;
  if (updatedAtPolicy !== 'git') {
    return '';
  }

  return readGitUpdatedAtIso(sourcePath);
}

async function readGitUpdatedAtIso(sourcePath) {
  const realSourcePath = await resolveRealPath(sourcePath);
  const realRootDir = await resolveRealPath(rootDir);
  const gitPath = path.relative(realRootDir, realSourcePath);
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      realRootDir,
      'log',
      '-1',
      '--format=%cI',
      '--',
      gitPath,
    ], {
      encoding: 'utf8',
    });

    const value = stdout.trim();
    if (!value) {
      warnGitUpdatedAt(sourcePath, 'no commit date was found for this file.');
      return '';
    }
    if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) {
      warnGitUpdatedAt(sourcePath, `unexpected git date output: ${value}`);
      return '';
    }
    return value;
  } catch (error) {
    warnGitUpdatedAt(sourcePath, error instanceof Error ? error.message : String(error));
    return '';
  }
}

async function resolveRealPath(value) {
  try {
    return await fs.realpath(value);
  } catch {
    return value;
  }
}

function warnGitUpdatedAt(sourcePath, reason) {
  console.warn([
    `[zeropress-build-pages] Warning: could not read git updated_at for ${formatSourcePath(sourcePath)}.`,
    `Reason: ${reason}`,
  ].join('\n'));
}

function warnInvalidFrontMatterUpdatedAt(sourcePath, value) {
  console.warn([
    `[zeropress-build-pages] Warning: ignored invalid front matter updated_at in ${formatSourcePath(sourcePath)}.`,
    `Reason: Expected "none", "git", or an ISO datetime string, received ${JSON.stringify(value)}.`,
  ].join('\n'));
}

function warnInvalidFrontMatterFeaturedImage(sourcePath, value, reason) {
  console.warn([
    `[zeropress-build-pages] Warning: ignored invalid front matter featured_image in ${formatSourcePath(sourcePath)}.`,
    `Reason: ${reason}`,
    `Received: ${JSON.stringify(value)}.`,
  ].join('\n'));
}

function isValidDateTimeString(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return false;
  }
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(new Date(value).getTime());
}

function isPreviewMetaValue(value) {
  return (
    value === null
    || typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value))
    || typeof value === 'boolean'
  );
}

function normalizeFrontMatterData(value, sourcePath) {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    throw new PrebuildMarkdownError(
      sourcePath,
      'front matter data must be an object when provided.',
    );
  }

  validateFrontMatterDataObject(value, sourcePath, 'data', 0);
  return value;
}

function validateFrontMatterDataValue(value, sourcePath, pathLabel, depth) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new PrebuildMarkdownError(
        sourcePath,
        `front matter ${pathLabel} must be a finite number.`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    validateFrontMatterDataArray(value, sourcePath, pathLabel, depth);
    return;
  }
  if (isPlainObject(value)) {
    validateFrontMatterDataObject(value, sourcePath, pathLabel, depth);
    return;
  }

  throw new PrebuildMarkdownError(
    sourcePath,
    `front matter ${pathLabel} must be JSON-safe structured data.`,
  );
}

function validateFrontMatterDataObject(object, sourcePath, pathLabel, depth) {
  if (depth > FRONT_MATTER_DATA_MAX_DEPTH) {
    throw new PrebuildMarkdownError(
      sourcePath,
      `front matter ${pathLabel} nesting must not exceed ${FRONT_MATTER_DATA_MAX_DEPTH} container levels.`,
    );
  }

  const entries = Object.entries(object);
  if (entries.length > FRONT_MATTER_DATA_MAX_KEYS) {
    throw new PrebuildMarkdownError(
      sourcePath,
      `front matter ${pathLabel} must not contain more than ${FRONT_MATTER_DATA_MAX_KEYS} keys.`,
    );
  }

  for (const [key, dataValue] of entries) {
    const childLabel = `${pathLabel}.${key}`;
    if (!FRONT_MATTER_DATA_KEY_PATTERN.test(key)) {
      throw new PrebuildMarkdownError(
        sourcePath,
        `front matter ${childLabel} uses an invalid key.`,
      );
    }
    validateFrontMatterDataValue(dataValue, sourcePath, childLabel, depth + 1);
  }
}

function validateFrontMatterDataArray(array, sourcePath, pathLabel, depth) {
  if (depth > FRONT_MATTER_DATA_MAX_DEPTH) {
    throw new PrebuildMarkdownError(
      sourcePath,
      `front matter ${pathLabel} nesting must not exceed ${FRONT_MATTER_DATA_MAX_DEPTH} container levels.`,
    );
  }

  if (array.length > FRONT_MATTER_DATA_MAX_ARRAY_LENGTH) {
    throw new PrebuildMarkdownError(
      sourcePath,
      `front matter ${pathLabel} must not contain more than ${FRONT_MATTER_DATA_MAX_ARRAY_LENGTH} items.`,
    );
  }

  array.forEach((dataValue, index) => {
    validateFrontMatterDataValue(dataValue, sourcePath, `${pathLabel}[${index}]`, depth + 1);
  });
}

function buildPageFeaturedImageUrl(value, sourcePath, siteUrl, publicAssetUrls) {
  if (!value) {
    return '';
  }

  if (value.startsWith('//')) {
    warnInvalidFrontMatterFeaturedImage(
      sourcePath,
      value,
      'protocol-relative URLs are not supported.',
    );
    return '';
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    const absoluteUrl = normalizeAbsoluteFeaturedImageUrl(value);
    if (absoluteUrl) {
      return absoluteUrl;
    }
    warnInvalidFrontMatterFeaturedImage(
      sourcePath,
      value,
      'featured_image must use http: or https: when an absolute URL is provided.',
    );
    return '';
  }

  let publicUrl = value;
  if (!value.startsWith('/')) {
    const rewrittenUrl = rewritePublicAssetTarget(value, sourcePath, publicAssetUrls);
    if (rewrittenUrl === value) {
      warnInvalidFrontMatterFeaturedImage(
        sourcePath,
        value,
        'source-relative featured_image must point to an existing file inside public-dir.',
      );
      return '';
    }
    publicUrl = rewrittenUrl;
  }

  if (!siteUrl) {
    warnInvalidFrontMatterFeaturedImage(
      sourcePath,
      value,
      'site.url is required to convert a public featured_image path into an absolute URL.',
    );
    return '';
  }

  const absoluteUrl = resolveSiteAbsoluteUrl(siteUrl, publicUrl);
  if (!absoluteUrl) {
    warnInvalidFrontMatterFeaturedImage(
      sourcePath,
      value,
      'featured_image could not be resolved against site.url.',
    );
    return '';
  }

  return absoluteUrl;
}

function normalizeAbsoluteFeaturedImageUrl(value) {
  try {
    const url = new URL(value);
    if (!FEATURED_IMAGE_PROTOCOLS.has(url.protocol) || !url.hostname) {
      return '';
    }
    return url.toString();
  } catch {
    return '';
  }
}

function resolveSiteAbsoluteUrl(siteUrl, publicUrl) {
  try {
    const url = new URL(publicUrl, siteUrl);
    if (!FEATURED_IMAGE_PROTOCOLS.has(url.protocol) || !url.hostname) {
      return '';
    }
    return url.toString();
  } catch {
    return '';
  }
}

function formatFrontMatterValue(value) {
  if (typeof value === 'string') {
    return `"${value}"`;
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

function extractTitleOrSkip(markdown, sourcePath, skippedMarkdown, frontMatterTitle = '') {
  if (frontMatterTitle) {
    return frontMatterTitle;
  }

  try {
    return extractTitle(markdown, sourcePath);
  } catch (error) {
    if (
      skipUntitledMarkdown
      && error instanceof PrebuildMarkdownError
      && error.code === 'untitled_markdown'
    ) {
      console.warn(formatSkippedMarkdownWarning(error.sourcePath, error.reason, '', 'Skipped untitled Markdown'));
      recordSkippedMarkdown(skippedMarkdown, error.sourcePath, error.reason);
      return '';
    }

    throw error;
  }
}

function recordSkippedMarkdown(skippedMarkdown, sourcePath, reason) {
  skippedMarkdown.push({
    file: formatSourcePath(sourcePath),
    reason,
  });
}

function formatSkippedMarkdownWarning(sourcePath, reason, expected = '', label = 'Skipped Markdown') {
  const lines = [
    `[zeropress-build-pages] ${label}: ${formatSourcePath(sourcePath)}`,
    `Reason: ${reason}`,
  ];
  if (expected) {
    lines.push(expected);
  }
  lines.push('This file was not added to preview-data pages.');
  return lines.join('\n');
}

async function listMarkdownFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (shouldIgnoreMarkdownDiscoverEntry(entry.name)) {
      continue;
    }

    const entryPath = path.join(dir, entry.name);
    if (isMarkdownDiscoverExcluded(entryPath)) {
      continue;
    }

    if (entry.isDirectory()) {
      files.push(...await listMarkdownFiles(entryPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(entryPath);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

async function buildPublicAssetUrlMap(dir) {
  const assetUrls = new Map();
  await collectPublicAssetUrls(dir, dir, assetUrls);
  return assetUrls;
}

async function collectPublicAssetUrls(root, currentDir, assetUrls) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    if (shouldIgnorePublicAssetEntry(entry.name) || entry.isSymbolicLink()) {
      continue;
    }

    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await collectPublicAssetUrls(root, entryPath, assetUrls);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    assetUrls.set(path.resolve(entryPath), buildPublicAssetUrl(root, entryPath));
  }
}

function buildPublicAssetUrl(root, filePath) {
  const relativePath = path.relative(root, filePath).replace(/\\/g, '/');
  const encodedPath = relativePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');

  return `/${encodedPath}`;
}

function shouldIgnorePublicAssetEntry(name) {
  const basename = String(name || '');
  const lowerName = basename.toLowerCase();
  return (
    basename.startsWith('.')
    || lowerName === 'node_modules'
    || lowerName === 'thumbs.db'
    || lowerName.endsWith('.key')
    || lowerName.endsWith('.pem')
  );
}

function buildMarkdownDiscoverExcludeRoots() {
  if (samePath(sourceDir, publicDir) || !isPathInside(sourceDir, publicDir)) {
    return [];
  }

  return [publicDir];
}

function isMarkdownDiscoverExcluded(entryPath) {
  return markdownDiscoverExcludeRoots.some((excludeRoot) => (
    samePath(entryPath, excludeRoot) || isPathInside(excludeRoot, entryPath)
  ));
}

function samePath(firstPath, secondPath) {
  return path.resolve(firstPath) === path.resolve(secondPath);
}

function shouldIgnoreMarkdownDiscoverEntry(name) {
  const basename = String(name || '');
  const lowerName = basename.toLowerCase();
  return (
    lowerName === 'node_modules'
    || lowerName === 'vendor'
    || basename.startsWith('.')
    || basename.startsWith('_')
    || basename.startsWith('#')
    || basename.endsWith('~')
  );
}

function buildPageRoute(sourcePath, options = {}) {
  const relativePath = path.relative(sourceDir, sourcePath).replace(/\\/g, '/');
  const routePath = buildRoutePath(relativePath, sourcePath, options);
  const slug = buildSlug(routePath);

  if (!slug) {
    throw new PrebuildMarkdownError(
      sourcePath,
      'unable to derive a route slug from the file path.',
      '  getting-started.md\n  docs/index.md',
    );
  }

  return pageRoute(slug, routePath);
}

function buildHtmlPageRoute(sourcePath, options = {}) {
  const relativePath = path.relative(sourceDir, sourcePath).replace(/\\/g, '/');
  const routePath = buildRoutePath(relativePath, sourcePath, {
    ...options,
    extensionPattern: /\.html$/i,
  });
  const slug = buildSlug(routePath);

  if (!slug) {
    throw new PrebuildConfigError(
      `front_page.file cannot derive a route slug: ${formatSourcePath(sourcePath)}`,
      'Use a source-root relative file path such as .zeropress/index.html or .zeropress/landing.html.',
    );
  }

  return pageRoute(slug, routePath);
}

function buildRoutePath(relativeSourcePath, sourcePath, options = {}) {
  if (options.routePath) {
    if (options.routePath === 'index' && !options.allowRootIndex) {
      throw new PrebuildMarkdownError(
        sourcePath,
        'front matter path "index" is reserved for the front page.',
        '  path: docs/index\n  path: guide',
      );
    }
    return options.routePath;
  }

  const extensionPattern = options.extensionPattern || /\.md$/i;
  const withoutExtension = relativeSourcePath.replace(extensionPattern, '').toLowerCase();
  const segments = withoutExtension
    .split('/')
    .map((segment) => sanitizePathSegment(segment))
    .filter(Boolean);

  const routePath = segments.join('/');
  if (routePath === 'index' && options.allowRootIndex) {
    return routePath;
  }
  if (!routePath || routePath === 'index') {
    throw new PrebuildMarkdownError(
      sourcePath,
      'root index Markdown is reserved for the theme home page.',
      '  docs/index.md\n  theme-authoring/index.md',
    );
  }

  return routePath;
}

function buildSlug(routePath) {
  const segments = routePath.split('/').filter(Boolean);
  if (segments.length > 1 && segments.at(-1) === 'index') {
    segments.pop();
  }
  return sanitizePathSegment(segments.join('-') || 'index');
}

function sanitizePathSegment(segment) {
  return segment
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function pageRoute(slug, routePath) {
  return {
    slug,
    path: routePath,
    url: buildPublicUrl(routePath),
  };
}

function buildPublicUrl(routePath) {
  if (routePath === 'index') {
    return '/';
  }
  if (routePath.endsWith('/index')) {
    return `/${routePath.slice(0, -'/index'.length)}/`;
  }
  return `/${routePath}`;
}

function buildSourceMarkdownUrl(sourcePath) {
  const relativePath = path.relative(sourceDir, sourcePath).replace(/\\/g, '/');
  const encodedPath = relativePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');

  return `/${encodedPath}`;
}

function extractTitle(markdown, sourcePath) {
  if (!markdown.trim()) {
    throw new PrebuildMarkdownError(
      sourcePath,
      'empty Markdown file.',
      expectedHeadingSyntax(),
      'untitled_markdown',
    );
  }

  const lines = markdown.split(/\r?\n/);
  const atxTitle = extractAtxH1(lines);
  if (atxTitle) {
    return atxTitle;
  }

  const setextTitle = extractSetextH1(lines);
  if (setextTitle) {
    return setextTitle;
  }

  throw new PrebuildMarkdownError(
    sourcePath,
    'missing top-level heading.',
    expectedHeadingSyntax(),
    'untitled_markdown',
  );
}

function extractAtxH1(lines) {
  for (const line of lines) {
    const match = line.match(/^#\s+(.+?)\s*$/);
    if (match) {
      return match[1].trim();
    }
  }

  return '';
}

function extractSetextH1(lines) {
  for (let index = 0; index < lines.length - 1; index += 1) {
    const titleLine = lines[index].trim();
    const underline = lines[index + 1].trim();
    if (titleLine && /^=+\s*$/.test(underline)) {
      return titleLine;
    }
  }

  return '';
}

function expectedHeadingSyntax() {
  return [
    '  # Page Title',
    '',
    '  Page Title',
    '  ==========',
  ].join('\n');
}

function extractExcerpt(markdown, title) {
  const paragraphs = markdown
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .filter((block) => !isMarkdownHeadingBlock(block))
    .filter((block) => !block.startsWith('```'));

  const first = paragraphs[0] || title;
  return first
    .replace(/^>\s*/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function extractHtmlExcerpt(html) {
  const text = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();

  return text.slice(0, 240);
}

function isMarkdownHeadingBlock(block) {
  if (block.startsWith('#')) {
    return true;
  }

  const lines = block.split(/\r?\n/);
  return Boolean(
    lines.length >= 2
    && lines[0].trim()
    && /^[=-]+$/.test(lines[1].trim()),
  );
}

function rewriteMarkdownLinks(markdown, sourcePath, routes, linkOutput = 'clean', publicAssetUrls = new Map()) {
  return rewriteMarkdownOutsideFences(markdown, (chunk) => {
    const withMarkdownLinks = chunk.replace(/(!?\[[^\]]+\]\()([^)]+)(\))/g, (full, prefix, rawTarget, suffix) => {
      const trimmedTarget = rawTarget.trim();
      const rewritten = rewriteLinkTarget(trimmedTarget, sourcePath, routes, linkOutput, publicAssetUrls);
      return rewritten === trimmedTarget ? full : `${prefix}${rewritten}${suffix}`;
    });

    return rewriteRawHtmlAssetLinks(withMarkdownLinks, sourcePath, publicAssetUrls);
  });
}

function rewriteMarkdownOutsideFences(markdown, rewriteChunk) {
  const lines = markdown.match(/.*(?:\r\n|\n|$)/g) || [];
  if (lines.at(-1) === '') {
    lines.pop();
  }

  const output = [];
  let buffer = '';
  let fence = null;

  const flushBuffer = () => {
    if (buffer) {
      output.push(rewriteChunk(buffer));
      buffer = '';
    }
  };

  for (const line of lines) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) {
        flushBuffer();
        fence = {
          char: marker[0],
          length: marker.length,
        };
        output.push(line);
        continue;
      }

      if (marker[0] === fence.char && marker.length >= fence.length) {
        fence = null;
      }
      output.push(line);
      continue;
    }

    if (fence) {
      output.push(line);
    } else {
      buffer += line;
    }
  }

  flushBuffer();
  return output.join('');
}

function rewriteLinkTarget(target, sourcePath, routes, linkOutput = 'clean', publicAssetUrls = new Map()) {
  if (shouldSkipContentUrl(target)) {
    return target;
  }

  const { pathname, suffix } = splitLinkTarget(target);
  if (pathname.toLowerCase().endsWith('.md')) {
    const resolvedPath = resolveContentTarget(pathname, sourcePath);
    const route = routes.get(resolvedPath);
    return route ? `${formatMarkdownLinkUrl(route.url, linkOutput)}${suffix}` : target;
  }

  return rewritePublicAssetTarget(target, sourcePath, publicAssetUrls);
}

function rewriteRawHtmlAssetLinks(html, sourcePath, publicAssetUrls) {
  return html.replace(/\b(href|src|poster|srcset)\s*=\s*(["'])(.*?)\2/gi, (full, attrName, quote, rawValue) => {
    const rewritten = attrName.toLowerCase() === 'srcset'
      ? rewriteSrcset(rawValue, sourcePath, publicAssetUrls)
      : rewritePublicAssetTarget(rawValue.trim(), sourcePath, publicAssetUrls);

    return rewritten === rawValue.trim() ? full : `${attrName}=${quote}${rewritten}${quote}`;
  });
}

function rewriteSrcset(value, sourcePath, publicAssetUrls) {
  return value.split(',').map((candidate) => {
    const prefix = candidate.match(/^\s*/)?.[0] || '';
    const suffix = candidate.match(/\s*$/)?.[0] || '';
    const trimmed = candidate.trim();
    if (!trimmed) {
      return candidate;
    }

    const parts = trimmed.split(/\s+/);
    const rewrittenUrl = rewritePublicAssetTarget(parts[0], sourcePath, publicAssetUrls);
    return `${prefix}${[rewrittenUrl, ...parts.slice(1)].join(' ')}${suffix}`;
  }).join(',');
}

function rewritePublicAssetTarget(target, sourcePath, publicAssetUrls) {
  if (shouldSkipContentUrl(target)) {
    return target;
  }

  const { pathname, suffix } = splitLinkTarget(target);
  if (!pathname || pathname.toLowerCase().endsWith('.md')) {
    return target;
  }

  const resolvedPath = resolveContentTarget(pathname, sourcePath);
  const publicUrl = publicAssetUrls.get(resolvedPath);
  return publicUrl ? `${publicUrl}${suffix}` : target;
}

function shouldSkipContentUrl(target) {
  return (
    !target
    || target.startsWith('#')
    || target.startsWith('/')
    || /^[a-z][a-z0-9+.-]*:/i.test(target)
    || target.startsWith('//')
  );
}

function formatMarkdownLinkUrl(routeUrl, linkOutput) {
  if (linkOutput !== 'html') {
    return routeUrl;
  }

  if (routeUrl === '/') {
    return '/index.html';
  }
  if (routeUrl.endsWith('/')) {
    return `${routeUrl}index.html`;
  }
  return `${routeUrl}.html`;
}

function splitLinkTarget(target) {
  const match = target.match(/^([^?#]*)([?#].*)?$/);
  return {
    pathname: match?.[1] || target,
    suffix: match?.[2] || '',
  };
}

function resolveContentTarget(targetPath, sourcePath) {
  return path.normalize(path.resolve(path.dirname(sourcePath), targetPath));
}

function menuItem(title, url) {
  return {
    title,
    url,
    target: '_self',
    children: [],
  };
}

function readEnv(name, fallback) {
  const value = process.env[name]?.trim();
  return value || fallback;
}

function readConfigString(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function readConfigInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function readBooleanEnv(name, fallback = false) {
  const value = process.env[name]?.trim();
  if (!value) {
    return fallback;
  }
  return value.toLowerCase() === 'true';
}

function resolveEnvPath(names, fallback) {
  const rawValue = names
    .map((name) => process.env[name]?.trim())
    .find(Boolean) || fallback;

  return path.resolve(rootDir, rawValue);
}

function resolveOptionalEnvPath(names, fallback) {
  const rawValue = names
    .map((name) => process.env[name]?.trim())
    .find(Boolean);

  return rawValue ? path.resolve(rootDir, rawValue) : fallback;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function formatSourcePath(sourcePath) {
  const relativePath = path.relative(rootDir, sourcePath);
  if (relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
    return relativePath.replace(/\\/g, '/');
  }

  return sourcePath.replace(/\\/g, '/');
}
