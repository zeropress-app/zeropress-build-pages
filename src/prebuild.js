import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { generateContentSlug, validateSlugSegment } from '@zeropress/slug-policy';
import MarkdownIt from 'markdown-it';
import { toTerminalSafeMultilineText, toTerminalSafeText } from './terminal.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const rootDir = process.cwd();
const packageDir = path.resolve(__dirname, '..');
const sourceDir = resolveEnvPath(['ZEROPRESS_BUILD_PAGES_SOURCE'], 'docs');
const publicDir = resolveEnvPath(['ZEROPRESS_BUILD_PAGES_PUBLIC_DIR'], sourceDir);
const defaultConfigPath = path.join(sourceDir, '.zeropress', 'config.json');
const configPathExplicit = Boolean(process.env.ZEROPRESS_BUILD_PAGES_CONFIG?.trim());
const configPath = resolveOptionalEnvPath(['ZEROPRESS_BUILD_PAGES_CONFIG'], defaultConfigPath);
const outDir = path.join(rootDir, '.zeropress-build-pages');
const buildPagesConfigPath = path.join(outDir, 'build-pages-config.json');
const previewDataPath = path.join(outDir, 'preview-data.json');
const buildReportPath = path.join(outDir, 'build-report.json');
const skipUntitledMarkdown = readBooleanEnv('ZEROPRESS_SKIP_UNTITLED_MARKDOWN');
const copyMarkdownSource = readBooleanEnv('ZEROPRESS_COPY_MARKDOWN_SOURCE', true);
const themeId = readEnv('ZEROPRESS_BUILD_PAGES_THEME_ID', '');
const FRONT_PAGE_TYPES = new Set(['theme_index', 'markdown', 'html']);
const CONFIG_ROOT_KEYS = ['$schema', 'version', 'site', 'markdown', 'front_page', 'custom_html', 'menus', 'collections'];
const MENU_ITEM_TARGETS = new Set(['_self', '_blank']);
const BUILD_PAGES_CONFIG_VERSION = '1.0';
const BUILD_PAGES_CONFIG_SCHEMA_URL = 'https://schemas.zeropress.dev/build-pages-config/v1.0/schema.json';
const LEGACY_BUILD_PAGES_CONFIG_VERSION = '0.1';
const LEGACY_BUILD_PAGES_PACKAGE_VERSION = '0.6.13';
const PREVIEW_DATA_SCHEMA_URL = 'https://schemas.zeropress.dev/preview-data/v0.7/schema.json';
const FRONT_MATTER_DATA_KEY_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*(?:-[a-zA-Z0-9_]+)*$/;
const FRONT_MATTER_DATA_MAX_DEPTH = 4;
const FRONT_MATTER_DATA_MAX_KEYS = 64;
const FRONT_MATTER_DATA_MAX_ARRAY_LENGTH = 256;
const CUSTOM_HTML_SLOT_MAX_CODE_POINTS = 65_536;
const FRONT_MATTER_DISCOVERABILITY_VALUES = new Set(['default', 'noindex', 'delist']);
const MARKDOWN_UPDATED_AT_VALUES = new Set(['none', 'git']);
const MARKDOWN_LINK_OUTPUT_VALUES = new Set(['clean', 'html']);
const FEATURED_IMAGE_PROTOCOLS = new Set(['http:', 'https:']);
const WEB_URL_PROTOCOLS = new Set(['http:', 'https:']);
const ABSOLUTE_WEB_URL_PATTERN = /^(?:[Hh][Tt][Tt][Pp][Ss]?):\/\/(?:[^/?#@]+@)?(?:\[[0-9A-Fa-f:.]+\]|[^/?#:@]+)(?::[0-9]+)?(?:[/?#].*)?$/u;
const UNSAFE_WEB_URL_CHARACTER_PATTERN = /[\s\\\p{Cc}]/u;
const MALFORMED_PERCENT_ENCODING_PATTERN = /%(?![0-9A-Fa-f]{2})/;
const ENCODED_UNSAFE_WEB_URL_CHARACTER_PATTERN = /%(?:0[0-9A-Fa-f]|1[0-9A-Fa-f]|7[Ff]|5[Cc])/;
const CONFIG_REFERENCE_URL = 'https://build-pages.zeropress.dev/reference/config/';
const markdownDiscoverExcludeRoots = buildMarkdownDiscoverExcludeRoots();
const markdownLinkParser = createMarkdownLinkParser();
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
  constructor(reason, expected = '', options = {}) {
    super(reason);
    this.name = 'PrebuildConfigError';
    this.reason = reason;
    this.expected = expected;
    this.code = options.code || 'INVALID_CONFIG';
    this.receivedVersion = options.receivedVersion;
  }
}

main().catch(handlePrebuildError);

async function main() {
  const packageJson = await readPackageJson();
  const config = await loadPrebuildConfig();
  validateConfigEnvelope(config);
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

  assertUniquePageRoutes(pageInputs);
  const routeBySourcePath = new Map(
    pageInputs.map(({ sourcePath, route }) => [sourcePath, route]),
  );
  if (frontPageConfig.type === 'markdown') {
    const frontPageSourcePath = path.resolve(sourceDir, frontPageConfig.file);
    const frontPageRoute = routeBySourcePath.get(frontPageSourcePath);
    if (frontPageRoute) {
      routeBySourcePath.set(frontPageSourcePath, {
        ...frontPageRoute,
        url: '/',
      });
    }
  }
  const publicAssetUrls = await buildPublicAssetUrlMap(publicDir);
  assertNoPageRoutePublicAssetConflicts(pageInputs, publicAssetUrls, copyMarkdownSource);
  const collections = normalizeCollections(config.collections, pageInputs, skippedMarkdown);
  if (Object.keys(collections.resolved).length > 0) {
    resolvedConfig.collections = collections.resolved;
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
      excerpt: frontMatter.description !== undefined ? frontMatter.description : '',
      status: 'published',
    });
  }

  const frontPageResult = await buildFrontPageData(frontPageConfig, pageInputs, resolvedConfig);
  if (frontPageResult.page) {
    pages.push(frontPageResult.page);
  }

  const site = buildSiteData(resolvedConfig, frontPageResult.frontPage);
  const previewPages = pages.map((page) => canonicalizePreviewPagePath(page, site.permalinks));
  const customHtml = await buildCustomHtmlData(customHtmlConfig);

  const previewData = {
    $schema: PREVIEW_DATA_SCHEMA_URL,
    version: '0.7',
    generator: 'zeropress-build-pages',
    generated_at: new Date().toISOString(),
    site,
    content: {
      authors: [],
      posts: [],
      pages: previewPages,
      categories: [],
      tags: [],
    },
    menus,
    widgets: {},
  };

  if (Object.keys(collections.preview).length > 0) {
    previewData.collections = collections.preview;
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
    pages: previewPages,
    skippedMarkdown,
    frontPageConfig,
    frontPage: frontPageResult.frontPage,
    customHtml,
  });
  await fs.writeFile(buildReportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(`Wrote ${toTerminalSafeText(path.relative(rootDir, previewDataPath))} with ${previewPages.length} pages`);
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
  console.error(`[zeropress-build-pages] Unexpected prebuild failure.\nReason: ${toTerminalSafeText(reason)}`);
  process.exitCode = 1;
}

function formatMarkdownError(error) {
  const blocks = [
    [
      `[zeropress-build-pages] Invalid Markdown page: ${toTerminalSafeText(formatSourcePath(error.sourcePath))}`,
      `Reason: ${toTerminalSafeText(error.reason)}`,
    ].join('\n'),
  ];

  if (error.expected) {
    blocks.push(`Expected one of:\n${toTerminalSafeMultilineText(error.expected)}`);
  }

  return joinErrorBlocks(blocks);
}

function formatConfigError(error) {
  const blocks = [
    [
      `[zeropress-build-pages] Invalid site config: ${toTerminalSafeText(formatSourcePath(configPath))}`,
      `Reason: ${toTerminalSafeText(error.reason)}`,
    ].join('\n'),
  ];

  if (error.expected) {
    blocks.push(`Expected:\n${toTerminalSafeMultilineText(error.expected)}`);
  }

  if (
    error.code === 'UNSUPPORTED_CONFIG_VERSION'
    && error.receivedVersion === LEGACY_BUILD_PAGES_CONFIG_VERSION
  ) {
    blocks.push([
      'Guidance:',
      `Migrate this config to Build Pages Config ${BUILD_PAGES_CONFIG_VERSION}:`,
      CONFIG_REFERENCE_URL,
      '',
      'For temporary compatibility, pin the last compatible CLI in the existing npx command:',
      `  npx --yes @zeropress/build-pages@${LEGACY_BUILD_PAGES_PACKAGE_VERSION} ...`,
    ].join('\n'));
  }

  return joinErrorBlocks(blocks);
}

function joinErrorBlocks(blocks) {
  return blocks.filter(Boolean).join('\n\n');
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
      if (configPathExplicit) {
        throw new PrebuildConfigError(
          `configured config file does not exist: ${formatSourcePath(configPath)}`,
        );
      }
      configFound = false;
      return {};
    }
    if (error instanceof SyntaxError) {
      throw new PrebuildConfigError(`config.json is not valid JSON: ${error.message}`);
    }
    throw error;
  }
}

function validateConfigEnvelope(config) {
  if (
    configFound
    && Object.hasOwn(config, 'version')
    && config.version === LEGACY_BUILD_PAGES_CONFIG_VERSION
  ) {
    throw new PrebuildConfigError(
      `Build Pages Config "${LEGACY_BUILD_PAGES_CONFIG_VERSION}" is not supported by this release; expected "${BUILD_PAGES_CONFIG_VERSION}".`,
      '',
      {
        code: 'UNSUPPORTED_CONFIG_VERSION',
        receivedVersion: config.version,
      },
    );
  }

  assertKnownConfigKeys(config, CONFIG_ROOT_KEYS, 'config');

  if (config.$schema !== undefined && typeof config.$schema !== 'string') {
    throw new PrebuildConfigError('$schema must be a string when provided.');
  }

  if (configFound && !Object.hasOwn(config, 'version')) {
    throw new PrebuildConfigError('version is required in an authored Build Pages config and must be exactly "1.0".');
  }

  if (config.version !== undefined && config.version !== BUILD_PAGES_CONFIG_VERSION) {
    throw new PrebuildConfigError('version must be exactly "1.0".');
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
    media_origin: '',
    locale: configuredSite.locale,
    posts_per_page: 10,
    date_style: 'medium',
    time_style: 'none',
    timezone: 'UTC',
    permalinks: defaultPermalinks(),
    front_page: frontPage,
    post_index: {
      enabled: false,
    },
    expose_generator: configuredSite.expose_generator !== false,
    search: {
      enabled: configuredSite.search !== false,
    },
  };

  if (configuredSite.robots.allow_indexing === false) {
    site.robots = { allow_indexing: false };
  }

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
    version: BUILD_PAGES_CONFIG_VERSION,
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
  assertKnownConfigKeys(configuredSite, ['title', 'description', 'url', 'logo', 'locale', 'expose_generator', 'search', 'robots', 'footer', 'meta'], 'site');
  const configuredSiteUrl = normalizeSiteUrl(configuredSite.url);
  const site = {
    title: readConfigNonBlankString(configuredSite.title, 'Documentation', 'site.title'),
    description: readConfigString(configuredSite.description, '', 'site.description'),
    url: normalizeSiteUrl(readEnv('ZEROPRESS_SITE_URL', configuredSiteUrl)),
    locale: normalizeSiteLocale(configuredSite.locale),
    expose_generator: readConfigBoolean(configuredSite.expose_generator, true, 'site.expose_generator'),
    search: readConfigBoolean(configuredSite.search, true, 'site.search'),
    robots: normalizeSiteRobots(configuredSite.robots),
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

function normalizeSiteRobots(value) {
  if (value === undefined) {
    return { allow_indexing: true };
  }
  if (!isPlainObject(value)) {
    throw new PrebuildConfigError('site.robots must be an object when provided.');
  }
  assertKnownConfigKeys(value, ['allow_indexing'], 'site.robots');
  if (!Object.hasOwn(value, 'allow_indexing')) {
    throw new PrebuildConfigError('site.robots.allow_indexing is required when site.robots is provided.');
  }
  return {
    allow_indexing: readConfigBoolean(value.allow_indexing, true, 'site.robots.allow_indexing'),
  };
}

function normalizeSiteUrl(value) {
  if (value === undefined || value === '') {
    return '';
  }
  if (typeof value !== 'string') {
    throw new PrebuildConfigError('site.url must be a string when provided.');
  }

  if (!isStructurallyValidAbsoluteWebUrl(value)) {
    throw new PrebuildConfigError(
      'site.url must be an absolute http: or https: URL when provided.',
      '  "site": { "url": "https://example.com" }',
    );
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new PrebuildConfigError(
      'site.url must be an absolute http: or https: URL when provided.',
      '  "site": { "url": "https://example.com" }',
    );
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PrebuildConfigError(
      'site.url must be an absolute http: or https: URL when provided.',
      '  "site": { "url": "https://example.com" }',
    );
  }

  if (
    url.username
    || url.password
    || url.pathname !== '/'
    || value.includes('?')
    || value.includes('#')
  ) {
    throw new PrebuildConfigError(
      'site.url must use the origin root without a path, query, or fragment. Subdirectory hosting is not supported.',
      '  "site": { "url": "https://example.com" }\nOmit site.url or use an empty string when the deployment URL is not known.',
    );
  }

  return url.origin;
}

function normalizeSiteLocale(value) {
  if (value === undefined) {
    return 'en-US';
  }
  if (typeof value !== 'string') {
    throw new PrebuildConfigError('site.locale must be a string when provided.');
  }

  if (value.trim() !== value || /\s/u.test(value) || value.length === 0) {
    throw new PrebuildConfigError('site.locale must be a non-empty locale string such as "en-US" or "ko-KR".');
  }
  try {
    return Intl.getCanonicalLocales(value)[0];
  } catch {
    throw new PrebuildConfigError('site.locale must be a valid BCP 47 language tag such as "en-US" or "ko-KR".');
  }
}

function normalizeSiteLogo(value) {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    throw new PrebuildConfigError('site.logo must be an object when provided.');
  }
  assertKnownConfigKeys(value, ['src', 'alt'], 'site.logo');

  const src = readConfigNonBlankString(value.src, undefined, 'site.logo.src');
  if (src !== value.src) {
    throw new PrebuildConfigError('site.logo.src must not contain leading or trailing whitespace.');
  }
  validateSiteLogoSrc(src);

  const logo = { src };
  if (value.alt !== undefined) {
    logo.alt = readConfigString(value.alt, undefined, 'site.logo.alt');
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
  if (value.copyright_text !== undefined) {
    footer.copyright_text = readConfigNonBlankString(
      value.copyright_text,
      undefined,
      'site.footer.copyright_text',
    );
  }

  if (value.attribution !== undefined) {
    if (typeof value.attribution !== 'boolean') {
      throw new PrebuildConfigError('site.footer.attribution must be a boolean when provided.');
    }
    footer.attribution = value.attribution;
  }

  return Object.keys(footer).length ? footer : undefined;
}

function validateSiteLogoSrc(value) {
  if (
    UNSAFE_WEB_URL_CHARACTER_PATTERN.test(value)
    || MALFORMED_PERCENT_ENCODING_PATTERN.test(value)
    || ENCODED_UNSAFE_WEB_URL_CHARACTER_PATTERN.test(value)
  ) {
    throw new PrebuildConfigError('site.logo.src contains an unsafe or malformed URL character.');
  }

  if (value.startsWith('/') && !value.startsWith('//') && value !== '/' && !hasDotUrlPathSegment(value.split(/[?#]/u, 1)[0])) {
    return;
  }

  if (!isStructurallyValidAbsoluteWebUrl(value)) {
    throw new PrebuildConfigError(
      'site.logo.src must be a root-relative URL path starting with / or an absolute HTTP(S) URL. Relative paths such as ./logo.svg and ../logo.svg are not supported.',
    );
  }

  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)
      || !url.hostname
      || url.username
      || url.password
      || url.pathname === '/'
      || hasDotUrlPathSegment(extractRawAbsolutePath(value))) {
      throw new Error('unsupported URL');
    }
  } catch {
    throw new PrebuildConfigError(
      'site.logo.src must be a root-relative URL path starting with / or an absolute HTTP(S) URL. Relative paths such as ./logo.svg and ../logo.svg are not supported.',
    );
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
    return {
      frontPage: {
        type: 'page',
        page_path: matchedPage.route.path,
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
  assertNoPagePathConflict(pageInputs, route.path, sourcePath);

  return {
      frontPage: {
        type: 'page',
        page_path: route.path,
    },
    page: {
      title: config.site?.title || 'Home',
      slug: route.slug,
      path: route.path,
      content: html,
      document_type: 'html',
      excerpt: '',
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
  if (!file.endsWith(expectedExtension)) {
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
  return filePath.startsWith('.zeropress/') && filePath.endsWith('.html');
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
  const content = await readRequiredSourceFile(sourcePath, `${pathLabel}.file`);
  if (exceedsUnicodeCodePointLimit(content, CUSTOM_HTML_SLOT_MAX_CODE_POINTS)) {
    throw new PrebuildConfigError(
      `${pathLabel}.file exceeds the ${CUSTOM_HTML_SLOT_MAX_CODE_POINTS.toLocaleString('en-US')} Unicode code point limit: ${formatSourcePath(sourcePath)}`,
    );
  }
  return content;
}

function exceedsUnicodeCodePointLimit(value, limit) {
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > limit) {
      return true;
    }
  }
  return false;
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
  if (!normalizedPath.endsWith(expectedExtension)) {
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

  const segments = value.split('/');
  if (
    value.trim() !== value
    || path.isAbsolute(value)
    || value.includes('\\')
    || /\p{Cc}/u.test(value)
    || value.includes('?')
    || value.includes('#')
    || segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new PrebuildConfigError(
      `${pathLabel} must be a safe source-root relative path.`,
      '  "front_page": { "type": "markdown", "file": "index.md" }\n  "front_page": { "type": "html", "file": ".zeropress/index.html", "layout": false }',
    );
  }

  return value;
}

async function readRequiredSourceFile(sourcePath, pathLabel) {
  const resolvedSourcePath = await resolveRequiredHtmlSourceFile(sourcePath, pathLabel);
  let content = '';
  try {
    content = await fs.readFile(resolvedSourcePath, 'utf8');
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

async function resolveRequiredHtmlSourceFile(sourcePath, pathLabel) {
  let sourceEntry;
  try {
    sourceEntry = await fs.lstat(sourcePath);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw new PrebuildConfigError(`${pathLabel} does not exist: ${formatSourcePath(sourcePath)}`);
    }
    throw error;
  }

  if (!sourceEntry.isFile() && !sourceEntry.isSymbolicLink()) {
    throw new PrebuildConfigError(`${pathLabel} must be a regular HTML file: ${formatSourcePath(sourcePath)}`);
  }

  let realSourceDir;
  let realHtmlRoot;
  let realSourcePath;
  try {
    [realSourceDir, realHtmlRoot, realSourcePath] = await Promise.all([
      fs.realpath(sourceDir),
      fs.realpath(path.join(sourceDir, '.zeropress')),
      fs.realpath(sourcePath),
    ]);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw new PrebuildConfigError(`${pathLabel} does not exist: ${formatSourcePath(sourcePath)}`);
    }
    throw error;
  }

  if (
    samePath(realSourceDir, realHtmlRoot)
    || !isPathInside(realSourceDir, realHtmlRoot)
    || samePath(realHtmlRoot, realSourcePath)
    || !isPathInside(realHtmlRoot, realSourcePath)
  ) {
    throw new PrebuildConfigError(
      `${pathLabel} must resolve to an HTML file inside the source .zeropress directory: ${formatSourcePath(sourcePath)}`,
    );
  }

  const resolvedStat = await fs.stat(realSourcePath);
  if (!resolvedStat.isFile()) {
    throw new PrebuildConfigError(`${pathLabel} must be a regular HTML file: ${formatSourcePath(sourcePath)}`);
  }

  return realSourcePath;
}

function assertUniquePageRoutes(pageInputs) {
  const routeOwners = new Map();
  for (const pageInput of pageInputs) {
    const routePath = pageInput.route.path.normalize('NFC');
    const existing = routeOwners.get(routePath);
    if (existing) {
      throw new PrebuildMarkdownError(
        pageInput.sourcePath,
        `effective page path ${JSON.stringify(routePath)} conflicts with ${formatSourcePath(existing.sourcePath)}.`,
        'Change one source path or front matter path so each effective Page route is unique.',
      );
    }
    routeOwners.set(routePath, pageInput);
  }
}

function assertNoPagePathConflict(pageInputs, routePath, sourcePath) {
  const normalizedRoutePath = routePath.normalize('NFC');
  const matchingPage = pageInputs.find((pageInput) => pageInput.route.path.normalize('NFC') === normalizedRoutePath);
  if (matchingPage) {
    throw new PrebuildConfigError(
      `front_page.file resolves to page path "${routePath}", which conflicts with ${formatSourcePath(matchingPage.sourcePath)}.`,
      `Move or rename ${toTerminalSafeText(formatSourcePath(sourcePath))}, or choose a different front_page.file.`,
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

function canonicalizePreviewPagePath(page, permalinks) {
  if (typeof page?.path !== 'string' || !page.path) {
    return page;
  }

  const outputStyle = permalinks?.output_style === 'html-extension'
    ? 'html-extension'
    : 'directory';
  const explicitRoute = buildPreviewPageRouteInfo(page.path, outputStyle, true);
  const fallbackPath = applyPreviewPagePermalinkPattern(permalinks?.pages, page.slug);
  const fallbackRoute = buildPreviewPageRouteInfo(fallbackPath, outputStyle, false);

  if (
    explicitRoute.url !== fallbackRoute.url
    || explicitRoute.outputPath !== fallbackRoute.outputPath
  ) {
    return page;
  }

  const { path: _path, ...pageWithoutPath } = page;
  return pageWithoutPath;
}

function applyPreviewPagePermalinkPattern(pattern, slug) {
  const body = String(pattern || '/:slug/').replace(/^\/+|\/+$/gu, '');
  const segments = body.split('/').filter(Boolean).map((segment) => (
    segment.startsWith(':')
      ? (segment === ':slug' ? slug : '')
      : segment
  ));
  return `/${segments.join('/')}/`;
}

function buildPreviewPageRouteInfo(routePath, outputStyle, useExplicitPagePathRules) {
  const normalizedPath = normalizePreviewRoutePath(routePath);
  return {
    url: useExplicitPagePathRules
      ? previewPagePathToPublicUrl(normalizedPath, outputStyle)
      : previewRoutePathToPublicUrl(normalizedPath, outputStyle),
    outputPath: previewRoutePathToOutputPath(normalizedPath, outputStyle),
  };
}

function normalizePreviewRoutePath(routePath) {
  if (!routePath || routePath === '/') {
    return '/';
  }

  let decodedPath = String(routePath);
  try {
    decodedPath = decodeURI(decodedPath);
  } catch {
    // Preserve malformed input so downstream validation can report it.
  }
  return `/${decodedPath.replace(/^\/+|\/+$/gu, '')}/`;
}

function previewRoutePathToOutputPath(routePath, outputStyle) {
  if (routePath === '/') {
    return 'index.html';
  }
  if (outputStyle === 'html-extension') {
    return `${routePath.replace(/^\/+|\/+$/gu, '')}.html`;
  }
  return `${routePath.replace(/^\//u, '')}index.html`;
}

function previewRoutePathToPublicUrl(routePath, outputStyle) {
  if (routePath === '/') {
    return '/';
  }
  if (outputStyle === 'html-extension') {
    return routePath.replace(/\/$/u, '');
  }
  return routePath;
}

function previewPagePathToPublicUrl(routePath, outputStyle) {
  if (outputStyle !== 'html-extension') {
    return previewRoutePathToPublicUrl(routePath, outputStyle);
  }

  const withoutTrailingSlash = routePath.replace(/\/$/u, '');
  if (withoutTrailingSlash === '/index') {
    return '/';
  }
  if (withoutTrailingSlash.endsWith('/index')) {
    return `${withoutTrailingSlash.slice(0, -'/index'.length)}/`;
  }
  return withoutTrailingSlash;
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
    validateConfigId(menuId, `menus.${menuId}`);
    if (!isPlainObject(menu)) {
      throw new PrebuildConfigError(`menus.${menuId} must be an object.`);
    }
    assertKnownConfigKeys(menu, ['name', 'items'], `menus.${menuId}`);
    if (!Array.isArray(menu.items)) {
      throw new PrebuildConfigError(`menus.${menuId}.items must be an array.`);
    }
    menus[menuId] = {
      name: readConfigNonBlankString(menu.name, menuId, `menus.${menuId}.name`),
      items: menu.items.map((item, index) => normalizeMenuItem(item, `menus.${menuId}.items[${index}]`)),
    };
  }

  return menus;
}

function normalizeMenuItem(item, pathLabel) {
  if (!isPlainObject(item)) {
    throw new PrebuildConfigError(`${pathLabel} must be an object.`);
  }
  assertKnownConfigKeys(item, ['title', 'url', 'target', 'meta', 'children'], pathLabel);
  const title = readConfigNonBlankString(item.title, undefined, `${pathLabel}.title`);
  const url = normalizeMenuUrl(item.url, `${pathLabel}.url`);

  if (item.children !== undefined && !Array.isArray(item.children)) {
    throw new PrebuildConfigError(`${pathLabel}.children must be an array when provided.`);
  }

  return {
    title,
    url,
    target: readConfigEnum(item.target, '_self', `${pathLabel}.target`, MENU_ITEM_TARGETS),
    ...(item.meta !== undefined ? { meta: normalizeMenuItemMeta(item.meta, `${pathLabel}.meta`) } : {}),
    children: item.children !== undefined
      ? item.children.map((child, index) => normalizeMenuItem(child, `${pathLabel}.children[${index}]`))
      : [],
  };
}

function normalizeMenuUrl(value, pathLabel) {
  if (typeof value !== 'string' || !value) {
    throw new PrebuildConfigError(
      `${pathLabel} must be a non-empty absolute HTTP(S) URL or root-relative Web path.`,
    );
  }
  if (
    value.trim() !== value
    || UNSAFE_WEB_URL_CHARACTER_PATTERN.test(value)
    || MALFORMED_PERCENT_ENCODING_PATTERN.test(value)
    || ENCODED_UNSAFE_WEB_URL_CHARACTER_PATTERN.test(value)
  ) {
    throw new PrebuildConfigError(`${pathLabel} contains an unsafe or malformed URL character.`);
  }
  if (value.startsWith('//')) {
    throw new PrebuildConfigError(`${pathLabel} must not use a protocol-relative URL.`);
  }

  if (!value.startsWith('/')) {
    if (!isStructurallyValidAbsoluteWebUrl(value)) {
      throw new PrebuildConfigError(`${pathLabel} must use http: or https: when an absolute URL is provided.`);
    }

    let url;
    try {
      url = new URL(value);
    } catch {
      throw new PrebuildConfigError(`${pathLabel} must be a valid absolute HTTP(S) URL.`);
    }
    if (!WEB_URL_PROTOCOLS.has(url.protocol) || !url.hostname || url.username || url.password || hasDotUrlPathSegment(extractRawAbsolutePath(value))) {
      throw new PrebuildConfigError(`${pathLabel} must be a valid absolute HTTP(S) URL.`);
    }
    return value;
  }

  const pathname = value.split(/[?#]/u, 1)[0];
  if (!pathname) {
    throw new PrebuildConfigError(`${pathLabel} must include an actual relative URL path before its query or fragment.`);
  }
  validateRootRelativeMenuPath(pathname, pathLabel);

  try {
    new URL(value, 'https://zeropress.invalid/');
  } catch {
    throw new PrebuildConfigError(`${pathLabel} must be a valid relative Web URL.`);
  }

  return value;
}

function isStructurallyValidAbsoluteWebUrl(value) {
  return value.trim() === value
    && !UNSAFE_WEB_URL_CHARACTER_PATTERN.test(value)
    && !MALFORMED_PERCENT_ENCODING_PATTERN.test(value)
    && !ENCODED_UNSAFE_WEB_URL_CHARACTER_PATTERN.test(value)
    && ABSOLUTE_WEB_URL_PATTERN.test(value);
}

function validateRootRelativeMenuPath(pathname, pathLabel) {
  if (pathname === '/') {
    return;
  }
  if (!pathname.startsWith('/') || hasDotUrlPathSegment(pathname)) {
    throw new PrebuildConfigError(`${pathLabel} must contain a safe root-relative Web path.`);
  }
}

function extractRawAbsolutePath(value) {
  const match = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*(?<path>[^?#]*)/u.exec(value);
  return match?.groups?.path || '/';
}

function hasDotUrlPathSegment(pathname) {
  return String(pathname || '').split('/').some((segment) => {
    if (!segment) return false;
    try {
      const decoded = decodeURIComponent(segment).normalize('NFC');
      return decoded === '.' || decoded === '..';
    } catch {
      return true;
    }
  });
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
    return {
      resolved: {},
      preview: {},
    };
  }
  if (!isPlainObject(value)) {
    throw new PrebuildConfigError('collections must be an object keyed by collection id.');
  }

  const pageBySourcePath = new Map(pageInputs.map((pageInput) => [pageInput.sourcePath, pageInput]));
  const skippedByFile = new Map(
    skippedMarkdown.map((entry) => [path.resolve(rootDir, entry.file), entry.reason]),
  );
  const resolvedCollections = {};
  const previewCollections = {};

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
    const resolvedItems = [];
    const previewItems = collection.items.map((item, index) => {
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

      resolvedItems.push(normalizedPath);
      return {
        type: 'page',
        path: pageInput.route.path,
      };
    });

    const resolvedCollection = {
      title: readConfigNonBlankString(
        collection.title,
        collectionId,
        `collections.${collectionId}.title`,
      ),
      ...(collection.description !== undefined ? {
        description: readConfigString(
          collection.description,
          undefined,
          `collections.${collectionId}.description`,
        ),
      } : {}),
      items: resolvedItems,
    };

    resolvedCollections[collectionId] = resolvedCollection;
    previewCollections[collectionId] = {
      ...resolvedCollection,
      items: previewItems,
    };
  }

  return {
    resolved: resolvedCollections,
    preview: previewCollections,
  };
}

function resolveCollectionSourcePath(value, pathLabel) {
  const normalizedPath = normalizeSourceFilePath(value, pathLabel);
  if (!normalizedPath.endsWith('.md')) {
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
    `- Source root: ${toTerminalSafeText(report.source_dir)}`,
    `- Public root: ${toTerminalSafeText(report.public_dir)}`,
    `- Theme: ${toTerminalSafeText(report.theme_id || 'unknown')}`,
    `- Markdown discovered: ${report.markdown.discovered}`,
    `- Markdown pages generated: ${report.markdown.generated_pages}`,
    `- Markdown skipped: ${report.markdown.skipped}`,
    `- Total preview pages: ${report.pages.total}`,
    `- Source config: ${toTerminalSafeText(formatConfigSummary(report))}`,
    `- Config reference: ${toTerminalSafeText(report.config_reference_url)}`,
    `- Resolved config: ${toTerminalSafeText(report.build_pages_config_path)} (generated effective config)`,
    `- Front page: ${toTerminalSafeText(formatFrontPageSummary(report.front_page))}`,
    `- Custom HTML slots: ${toTerminalSafeText(report.custom_html.length ? report.custom_html.join(', ') : 'none')}`,
    `- Report: ${toTerminalSafeText(report.report_path)}`,
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
    return `markdown ${config.file} -> / (${previewData.page_path})`;
  }
  if (previewData.type === 'standalone_html') {
    return `html ${config.file} -> / (standalone_html)`;
  }
  return `html ${config.file} -> / (${previewData.page_path})`;
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
      data: createYamlMapping(),
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
    return createYamlMapping();
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
  const object = createYamlMapping();
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
    return createYamlMapping();
  }

  const object = createYamlMapping();
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
  if (typeof value !== 'string' || !value) {
    throw new PrebuildMarkdownError(
      sourcePath,
      'front matter path must be a non-empty string when provided.',
    );
  }

  const segments = value.split('/');
  if (
    value.startsWith('/')
    || value.endsWith('/')
    || value.includes('\\')
    || value.includes('?')
    || value.includes('#')
  ) {
    throw new PrebuildMarkdownError(
      sourcePath,
      'front matter path must be a safe generated route path.',
      '  path: guides/install\n  path: spec/preview-data-v0.7',
    );
  }

  const normalizedSegments = [];
  for (const segment of segments) {
    const result = validateSlugSegment(segment);
    if (!result.ok) {
      throw new PrebuildMarkdownError(
        sourcePath,
        `front matter path segment ${JSON.stringify(segment)} is invalid: ${result.issues[0]?.message || 'invalid slug segment'}.`,
        '  path: guides/install\n  path: 가이드/설치_방법',
      );
    }
    normalizedSegments.push(result.normalized);
  }

  const normalizedPath = normalizedSegments.join('/');
  assertRoutePathDoesNotContainHtmlSegment(normalizedPath, sourcePath, 'front matter path');
  return normalizedPath;
}

function assertRoutePathDoesNotContainHtmlSegment(routePath, sourcePath, label) {
  if (!routePath.split('/').some((segment) => segment.endsWith('.html'))) {
    return;
  }
  throw new PrebuildMarkdownError(
    sourcePath,
    `${label} must not contain a segment ending with the literal lowercase suffix ".html".`,
    'Remove the .html suffix; Build Pages selects the output filename from the permalink output style.',
  );
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
  const sourceDirectory = path.dirname(realSourcePath);
  const gitPath = path.basename(realSourcePath);
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      sourceDirectory,
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
    `[zeropress-build-pages] Warning: could not read git updated_at for ${toTerminalSafeText(formatSourcePath(sourcePath))}.`,
    `Reason: ${toTerminalSafeText(reason)}`,
  ].join('\n'));
}

function warnInvalidFrontMatterUpdatedAt(sourcePath, value) {
  console.warn([
    `[zeropress-build-pages] Warning: ignored invalid front matter updated_at in ${toTerminalSafeText(formatSourcePath(sourcePath))}.`,
    `Reason: Expected "none", "git", or an ISO datetime string, received ${toTerminalSafeText(JSON.stringify(value))}.`,
  ].join('\n'));
}

function warnInvalidFrontMatterFeaturedImage(sourcePath, value, reason) {
  console.warn([
    `[zeropress-build-pages] Warning: ignored invalid front matter featured_image in ${toTerminalSafeText(formatSourcePath(sourcePath))}.`,
    `Reason: ${toTerminalSafeText(reason)}`,
    `Received: ${toTerminalSafeText(JSON.stringify(value))}.`,
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
    if (!FEATURED_IMAGE_PROTOCOLS.has(url.protocol)
      || !url.hostname
      || url.username
      || url.password
      || url.pathname === '/'
      || !isStructurallyValidAbsoluteWebUrl(value)
      || hasDotUrlPathSegment(extractRawAbsolutePath(value))) {
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
    if (!FEATURED_IMAGE_PROTOCOLS.has(url.protocol)
      || !url.hostname
      || url.username
      || url.password
      || url.pathname === '/') {
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
    `[zeropress-build-pages] ${label}: ${toTerminalSafeText(formatSourcePath(sourcePath))}`,
    `Reason: ${toTerminalSafeText(reason)}`,
  ];
  if (expected) {
    lines.push(toTerminalSafeMultilineText(expected));
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

function assertNoPageRoutePublicAssetConflicts(pageInputs, publicAssetUrls, includeMarkdownSource) {
  const publicFilesByUrl = new Map();
  for (const [filePath, publicUrl] of publicAssetUrls) {
    if (!includeMarkdownSource && filePath.toLowerCase().endsWith('.md')) {
      continue;
    }
    publicFilesByUrl.set(normalizePublicUrlCollisionKey(publicUrl), publicUrl);
  }
  if (includeMarkdownSource) {
    for (const pageInput of pageInputs) {
      const sourceMarkdownUrl = buildSourceMarkdownUrl(pageInput.sourcePath);
      publicFilesByUrl.set(normalizePublicUrlCollisionKey(sourceMarkdownUrl), sourceMarkdownUrl);
    }
  }

  for (const pageInput of pageInputs) {
    const routeUrl = pageInput.route.url;
    const publicFileUrl = publicFilesByUrl.get(normalizePublicUrlCollisionKey(routeUrl));
    if (!publicFileUrl) {
      continue;
    }

    throw new PrebuildMarkdownError(
      pageInput.sourcePath,
      `route ${JSON.stringify(routeUrl)} conflicts with public file ${JSON.stringify(publicFileUrl)}.`,
      'Change the front matter path or rename the public file so each public URL has one owner.',
    );
  }
}

function normalizePublicUrlCollisionKey(value) {
  const url = new URL(String(value || '/'), 'https://zeropress.invalid');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    pathname = url.pathname;
  }
  return pathname.normalize('NFC').replace(/\/+$/, '') || '/';
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
    extensionPattern: /\.html$/,
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
    assertRoutePathDoesNotContainHtmlSegment(options.routePath, sourcePath, 'front matter path');
    return options.routePath;
  }

  const extensionPattern = options.extensionPattern || /\.md$/;
  const withoutExtension = relativeSourcePath.replace(extensionPattern, '');
  const segments = withoutExtension.split('/').map((segment) => {
    const generated = generateContentSlug(segment);
    if (!generated) {
      throw new PrebuildMarkdownError(
        sourcePath,
        `source path segment ${JSON.stringify(segment)} cannot derive a route slug.`,
        'Rename every source path segment so it contains at least one Unicode letter or decimal digit.',
      );
    }
    return generated;
  });

  const routePath = segments.join('/');
  assertRoutePathDoesNotContainHtmlSegment(routePath, sourcePath, 'filename-derived route');
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
  return generateContentSlug(segments.at(-1) || 'index');
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

  const lines = maskFencedCodeLines(markdown.split(/\r?\n/));
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

function maskFencedCodeLines(lines) {
  let fence = null;

  return lines.map((line) => {
    if (fence) {
      const closingMatch = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (
        closingMatch
        && closingMatch[1][0] === fence.char
        && closingMatch[1].length >= fence.length
      ) {
        fence = null;
      }
      return '';
    }

    const openingMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!openingMatch) {
      return line;
    }

    const marker = openingMatch[1];
    if (marker[0] === '`' && openingMatch[2].includes('`')) {
      return line;
    }

    fence = {
      char: marker[0],
      length: marker.length,
    };
    return '';
  });
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

function rewriteMarkdownLinks(markdown, sourcePath, routes, linkOutput = 'clean', publicAssetUrls = new Map()) {
  return rewriteMarkdownOutsideCodeBlocks(markdown, (chunk) => {
    const withMarkdownLinks = rewriteInlineMarkdownLinks(chunk, (target) => (
      rewriteLinkTarget(target, sourcePath, routes, linkOutput, publicAssetUrls)
    ));

    return rewriteMarkdownOutsideInlineCode(withMarkdownLinks, (text) => (
      rewriteRawHtmlAssetLinks(text, sourcePath, publicAssetUrls)
    ));
  });
}

function createMarkdownLinkParser() {
  const markdown = new MarkdownIt({
    html: true,
    linkify: false,
  });

  markdown.inline.ruler.before('link', 'zeropress_link_destination', (state, silent) => (
    recordInlineMarkdownLinkDestination(state, silent, false)
  ));
  markdown.inline.ruler.before('image', 'zeropress_image_destination', (state, silent) => (
    recordInlineMarkdownLinkDestination(state, silent, true)
  ));

  return markdown;
}

function rewriteInlineMarkdownLinks(markdown, rewriteTarget) {
  const destinations = [];
  markdownLinkParser.inline.parse(markdown, markdownLinkParser, {
    zeropressLinkDestinations: destinations,
  }, []);

  let rewrittenMarkdown = markdown;
  for (const destination of destinations.sort((left, right) => right.start - left.start)) {
    const rewrittenTarget = rewriteTarget(destination.target);
    if (rewrittenTarget === destination.target) {
      continue;
    }
    rewrittenMarkdown = `${rewrittenMarkdown.slice(0, destination.start)}${rewrittenTarget}${rewrittenMarkdown.slice(destination.end)}`;
  }
  return rewrittenMarkdown;
}

function recordInlineMarkdownLinkDestination(state, silent, isImage) {
  const destinations = state.env?.zeropressLinkDestinations;
  const labelMarker = isImage ? state.pos + 1 : state.pos;
  if (
    silent
    || !Array.isArray(destinations)
    || state.src[labelMarker] !== '['
    || (isImage && state.src[state.pos] !== '!')
  ) {
    return false;
  }

  const labelEnd = state.md.helpers.parseLinkLabel(state, labelMarker, !isImage);
  if (labelEnd < 0 || state.src[labelEnd + 1] !== '(') {
    return false;
  }

  const max = state.posMax;
  let position = skipMarkdownLinkWhitespace(state.src, labelEnd + 2, max);
  const destinationStart = position;
  const destination = state.md.helpers.parseLinkDestination(state.src, position, max);
  if (!destination.ok) {
    return false;
  }
  position = destination.pos;

  const titleWhitespaceStart = position;
  position = skipMarkdownLinkWhitespace(state.src, position, max);
  const title = state.md.helpers.parseLinkTitle(state.src, position, max);
  if (titleWhitespaceStart !== position && title.ok) {
    position = skipMarkdownLinkWhitespace(state.src, title.pos, max);
  }

  if (state.src[position] !== ')') {
    return false;
  }

  const normalizedTarget = state.md.normalizeLink(destination.str);
  if (!state.md.validateLink(normalizedTarget)) {
    return false;
  }

  const angleDestination = state.src[destinationStart] === '<';
  destinations.push({
    start: angleDestination ? destinationStart + 1 : destinationStart,
    end: angleDestination ? destination.pos - 1 : destination.pos,
    target: destination.str,
  });
  return false;
}

function skipMarkdownLinkWhitespace(markdown, start, max) {
  let position = start;
  while (position < max) {
    const code = markdown.charCodeAt(position);
    if (code !== 0x09 && code !== 0x0A && code !== 0x20) {
      break;
    }
    position++;
  }
  return position;
}

function rewriteMarkdownOutsideInlineCode(markdown, rewriteChunk) {
  let output = '';
  let chunkStart = 0;
  let position = 0;

  while (position < markdown.length) {
    if (markdown[position] === '\\') {
      position = Math.min(position + 2, markdown.length);
      continue;
    }
    if (markdown[position] !== '`') {
      position++;
      continue;
    }

    const codeSpanEnd = findInlineCodeSpanEnd(markdown, position);
    if (!codeSpanEnd) {
      position = findMarkerRunEnd(markdown, position, '`');
      continue;
    }

    output += rewriteChunk(markdown.slice(chunkStart, position));
    output += markdown.slice(position, codeSpanEnd);
    chunkStart = codeSpanEnd;
    position = codeSpanEnd;
  }

  return `${output}${rewriteChunk(markdown.slice(chunkStart))}`;
}

function findInlineCodeSpanEnd(markdown, start) {
  const openerEnd = findMarkerRunEnd(markdown, start, '`');
  const openerLength = openerEnd - start;
  let position = openerEnd;

  while (position < markdown.length) {
    const markerStart = markdown.indexOf('`', position);
    if (markerStart < 0) {
      return null;
    }
    const markerEnd = findMarkerRunEnd(markdown, markerStart, '`');
    if (markerEnd - markerStart === openerLength) {
      return markerEnd;
    }
    position = markerEnd;
  }

  return null;
}

function findMarkerRunEnd(markdown, start, marker) {
  let position = start;
  while (markdown[position] === marker) {
    position++;
  }
  return position;
}

function rewriteMarkdownOutsideCodeBlocks(markdown, rewriteChunk) {
  const lines = markdown.match(/.*(?:\r\n|\n|$)/g) || [];
  if (lines.at(-1) === '') {
    lines.pop();
  }

  const blockTokens = [];
  markdownLinkParser.block.parse(markdown, markdownLinkParser, {}, blockTokens);
  const codeBlockLines = new Set();
  for (const token of blockTokens) {
    if (!['code_block', 'fence'].includes(token.type) || !token.map) {
      continue;
    }
    for (let lineNumber = token.map[0]; lineNumber < token.map[1]; lineNumber++) {
      codeBlockLines.add(lineNumber);
    }
  }

  const output = [];
  let buffer = '';

  const flushBuffer = () => {
    if (buffer) {
      output.push(rewriteChunk(buffer));
      buffer = '';
    }
  };

  for (const [lineNumber, line] of lines.entries()) {
    if (codeBlockLines.has(lineNumber)) {
      flushBuffer();
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

function readConfigString(value, fallback, pathName) {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'string') {
    throw new PrebuildConfigError(`${pathName} must be a string when provided.`);
  }
  return value;
}

function readConfigNonBlankString(value, fallback, pathName) {
  if (value === undefined) {
    if (fallback === undefined) {
      throw new PrebuildConfigError(`${pathName} is required and must be a non-empty string.`);
    }
    return fallback;
  }
  if (typeof value !== 'string' || !value.trim()) {
    throw new PrebuildConfigError(`${pathName} must be a non-empty string when provided.`);
  }
  return value.trim();
}

function readConfigEnum(value, fallback, pathName, allowedValues) {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'string' || !allowedValues.has(value)) {
    throw new PrebuildConfigError(
      `${pathName} must be one of: ${Array.from(allowedValues).join(', ')}.`,
    );
  }
  return value;
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function createYamlMapping() {
  return Object.create(null);
}

function formatSourcePath(sourcePath) {
  const relativePath = path.relative(rootDir, sourcePath);
  if (relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
    return relativePath.replace(/\\/g, '/');
  }

  return sourcePath.replace(/\\/g, '/');
}
