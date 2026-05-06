import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = process.cwd();
const sourceDir = resolveEnvPath(['ZEROPRESS_BUILD_PAGES_SOURCE', 'ZEROPRESS_PUBLIC_DIR'], 'docs');
const defaultConfigPath = path.join(sourceDir, '.zeropress', 'config.json');
const configPath = resolveOptionalEnvPath(['ZEROPRESS_BUILD_PAGES_CONFIG'], defaultConfigPath);
const outDir = path.join(rootDir, '.zeropress');
const previewDataPath = path.join(outDir, 'preview-data.json');
const buildReportPath = path.join(outDir, 'build-report.json');
const skipUntitledMarkdown = readBooleanEnv('ZEROPRESS_SKIP_UNTITLED_MARKDOWN');
const FRONT_PAGE_TYPES = new Set(['theme_index', 'markdown', 'html']);
const PREVIEW_DATA_SCHEMA_URL = 'https://zeropress.dev/schemas/preview-data.v0.5.schema.json';

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
  const config = await loadPrebuildConfig();
  const frontPageConfig = await normalizeDefaultFrontPageConfig(
    normalizeFrontPageConfig(config.front_page),
    config.front_page,
  );
  const sourceFiles = await listMarkdownFiles(sourceDir);
  const skippedMarkdown = [];
  const pageInputs = [];

  for (const sourcePath of sourceFiles) {
    const rawMarkdown = await fs.readFile(sourcePath, 'utf8');
    const title = extractTitleOrSkip(rawMarkdown, sourcePath, skippedMarkdown);
    if (!title) {
      continue;
    }

    pageInputs.push({
      sourcePath,
      rawMarkdown,
      title,
      route: buildPageRoute(sourcePath, {
        allowRootIndex: shouldAllowRootMarkdownIndex(frontPageConfig),
      }),
    });
  }

  const routeBySourcePath = new Map(
    pageInputs.map(({ sourcePath, route }) => [sourcePath, route]),
  );

  const pages = pageInputs.map(({ sourcePath, rawMarkdown, title, route }) => ({
    title,
    slug: route.slug,
    path: route.path,
    meta: {
      source_markdown_url: buildSourceMarkdownUrl(sourcePath),
    },
    content: rewriteMarkdownLinks(rawMarkdown, sourcePath, routeBySourcePath),
    document_type: 'markdown',
    excerpt: extractExcerpt(rawMarkdown, title),
    status: 'published',
  }));

  const frontPageResult = await buildFrontPageData(frontPageConfig, pageInputs, config);
  if (frontPageResult.page) {
    pages.push(frontPageResult.page);
  }

  const site = buildSiteData(config, frontPageResult.frontPage);
  const menus = normalizeMenus(config.menus);
  const customHtml = await buildCustomHtmlData(config.custom_html);

  const previewData = {
    $schema: PREVIEW_DATA_SCHEMA_URL,
    version: '0.5',
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
  if (customHtml) {
    previewData.custom_html = customHtml;
  }

  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(previewDataPath, `${JSON.stringify(previewData, null, 2)}\n`, 'utf8');

  const report = buildPrebuildReport({
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
    const parsed = JSON.parse(rawConfig);
    if (!isPlainObject(parsed)) {
      throw new PrebuildConfigError('config.json must contain a JSON object.');
    }
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {};
    }
    if (error instanceof SyntaxError) {
      throw new PrebuildConfigError(`config.json is not valid JSON: ${error.message}`);
    }
    throw error;
  }
}

function buildSiteData(config, frontPage) {
  const configuredSite = isPlainObject(config.site) ? config.site : {};
  const footer = normalizeFooter(configuredSite.footer);

  const site = {
    title: readConfigString(configuredSite.title, 'ZeroPress Site'),
    description: readConfigString(configuredSite.description, 'Documentation built with ZeroPress.'),
    url: readEnv('ZEROPRESS_SITE_URL', readConfigString(configuredSite.url, '')),
    mediaBaseUrl: readConfigString(configuredSite.mediaBaseUrl, ''),
    locale: readConfigString(configuredSite.locale, 'en-US'),
    postsPerPage: readConfigInteger(configuredSite.postsPerPage, 10),
    dateFormat: readConfigString(configuredSite.dateFormat, 'YYYY-MM-DD'),
    timeFormat: readConfigString(configuredSite.timeFormat, 'HH:mm'),
    timezone: readConfigString(configuredSite.timezone, 'UTC'),
    permalinks: normalizePermalinks(configuredSite.permalinks),
    front_page: frontPage,
    post_index: {
      enabled: false,
    },
    disallowComments: configuredSite.disallowComments !== false,
  };

  if (footer) {
    site.footer = footer;
  }

  return site;
}

function normalizeFooter(value) {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const footer = {};
  const copyrightText = readConfigString(value.copyright_text, '');
  if (copyrightText) {
    footer.copyright_text = copyrightText;
  }

  if (isPlainObject(value.attribution) && typeof value.attribution.enabled === 'boolean') {
    footer.attribution = {
      enabled: value.attribution.enabled,
    };
  }

  return Object.keys(footer).length ? footer : undefined;
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

async function buildCustomHtmlData(value) {
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

  const customHtml = {};
  if (value.head_end !== undefined) {
    customHtml.head_end = await buildCustomHtmlSlotData(value.head_end, 'custom_html.head_end');
  }
  if (value.body_end !== undefined) {
    customHtml.body_end = await buildCustomHtmlSlotData(value.body_end, 'custom_html.body_end');
  }

  return customHtml;
}

async function buildCustomHtmlSlotData(value, pathLabel) {
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

  const sourcePath = resolveConfiguredSourceFile(file, '.html', `${pathLabel}.file`);
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

function normalizePermalinks(value) {
  return {
    output_style: readConfigString(value?.output_style, 'html-extension'),
    posts: readConfigString(value?.posts, '/posts/:slug/'),
    pages: readConfigString(value?.pages, '/:slug/'),
    categories: readConfigString(value?.categories, '/categories/:slug/'),
    tags: readConfigString(value?.tags, '/tags/:slug/'),
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
    type: readConfigString(item.type, 'custom'),
    target: readConfigString(item.target, '_self'),
    children: Array.isArray(item.children)
      ? item.children.map((child, index) => normalizeMenuItem(child, `${pathLabel}.children[${index}]`))
      : [],
  };
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

function buildPrebuildReport({
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
    source_dir: formatSourcePath(sourceDir),
    config_path: formatSourcePath(configPath),
    preview_data_path: formatSourcePath(previewDataPath),
    report_path: formatSourcePath(buildReportPath),
    skip_untitled_markdown: skipUntitledMarkdown,
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
    `- Public root: ${report.source_dir}`,
    `- Markdown discovered: ${report.markdown.discovered}`,
    `- Markdown pages generated: ${report.markdown.generated_pages}`,
    `- Markdown skipped: ${report.markdown.skipped}`,
    `- Total preview pages: ${report.pages.total}`,
    `- Front page: ${formatFrontPageSummary(report.front_page)}`,
    `- Custom HTML slots: ${report.custom_html.length ? report.custom_html.join(', ') : 'none'}`,
    `- Report: ${report.report_path}`,
  ];

  console.log(lines.join('\n'));
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

function extractTitleOrSkip(markdown, sourcePath, skippedMarkdown) {
  try {
    return extractTitle(markdown, sourcePath);
  } catch (error) {
    if (
      skipUntitledMarkdown
      && error instanceof PrebuildMarkdownError
      && error.code === 'untitled_markdown'
    ) {
      console.warn(formatSkippedUntitledMarkdownWarning(error));
      skippedMarkdown.push({
        file: formatSourcePath(error.sourcePath),
        reason: error.reason,
      });
      return '';
    }

    throw error;
  }
}

function formatSkippedUntitledMarkdownWarning(error) {
  return [
    `[zeropress-build-pages] Skipped untitled Markdown: ${formatSourcePath(error.sourcePath)}`,
    `Reason: ${error.reason}`,
    'This file was not added to preview-data pages.',
  ].join('\n');
}

async function listMarkdownFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (shouldIgnoreMarkdownDiscoverEntry(entry.name)) {
      continue;
    }

    const entryPath = path.join(dir, entry.name);
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
  const segments = routePath.split('/');
  const rawSlug = segments.at(-1) === 'index' && segments.length > 1
    ? segments.at(-2)
    : segments.at(-1);
  return sanitizePathSegment(rawSlug || '');
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

function rewriteMarkdownLinks(markdown, sourcePath, routes) {
  return markdown.replace(/(\[[^\]]+\]\()([^)]+)(\))/g, (full, prefix, rawTarget, suffix) => {
    const rewritten = rewriteLinkTarget(rawTarget.trim(), sourcePath, routes);
    return rewritten === rawTarget.trim() ? full : `${prefix}${rewritten}${suffix}`;
  });
}

function rewriteLinkTarget(target, sourcePath, routes) {
  if (
    !target ||
    target.startsWith('#') ||
    /^[a-z][a-z0-9+.-]*:/i.test(target) ||
    target.startsWith('//')
  ) {
    return target;
  }

  const { pathname, suffix } = splitLinkTarget(target);
  if (!pathname.endsWith('.md')) {
    return target;
  }

  const resolvedPath = resolveMarkdownTarget(pathname, sourcePath);
  const route = routes.get(resolvedPath);
  return route ? `${route.url}${suffix}` : target;
}

function splitLinkTarget(target) {
  const match = target.match(/^([^?#]*)([?#].*)?$/);
  return {
    pathname: match?.[1] || target,
    suffix: match?.[2] || '',
  };
}

function resolveMarkdownTarget(targetPath, sourcePath) {
  if (targetPath.startsWith('/')) {
    return path.normalize(path.join(sourceDir, targetPath.replace(/^\/+/, '')));
  }

  return path.normalize(path.resolve(path.dirname(sourcePath), targetPath));
}

function menuItem(title, url) {
  return {
    title,
    url,
    type: 'custom',
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

function readBooleanEnv(name) {
  return process.env[name]?.trim().toLowerCase() === 'true';
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
