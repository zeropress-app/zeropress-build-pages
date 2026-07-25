import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBuild } from '@zeropress/build';
import { checkInternalLinks } from './check-links.js';
import { toTerminalSafeText } from './terminal.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, '..');
const prebuildScript = __dirname === path.join(packageDir, 'dist')
  ? path.join(__dirname, 'prebuild.js')
  : path.join(packageDir, 'src', 'prebuild.js');
const INTERNAL_WORK_DIR = '.zeropress-build-pages';
const PREVIEW_DATA_PATH = `${INTERNAL_WORK_DIR}/preview-data.json`;
const STAGING_DIR = `${INTERNAL_WORK_DIR}/public-assets`;
const DEFAULT_THEME = 'docs';
const BUILD_PAGES_DOCS_URL = 'https://build-pages.zeropress.dev/';
const BUNDLED_THEME_ALIASES = new Map([
  ['docs', 'docs1'],
  ['docs1', 'docs1'],
  ['docs2', 'docs2'],
  ['plain', 'plain'],
]);

export async function runCli(argv = process.argv.slice(2)) {
  try {
    if (argv.length === 0) {
      printHelp();
      return;
    }
    if (argv.includes('--help') || argv.includes('-h')) {
      printHelp();
      return;
    }
    if (argv.includes('--version') || argv.includes('-v')) {
      const packageJson = JSON.parse(await fs.readFile(path.join(packageDir, 'package.json'), 'utf8'));
      console.log(packageJson.version);
      return;
    }

    const options = parseArgs(argv, process.env);
    await runBuildPages(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(colorizeError(prefixError(toTerminalSafeText(message))));
    process.exitCode = 1;
  }
}

export async function runBuildPages(options) {
  const packageJson = await readPackageJson();
  console.log(formatBuildPagesBanner(packageJson.version));
  console.log(`Docs: ${formatDocsUrl(packageJson.homepage || BUILD_PAGES_DOCS_URL)}`);
  console.log('');

  const cwd = path.resolve(options.cwd || process.cwd());
  const copyMarkdownSource = options.copyMarkdownSource !== false;
  const sourceDir = path.resolve(cwd, options.source);
  const publicDirExplicit = hasExplicitPublicDir(options);
  const publicDir = publicDirExplicit ? path.resolve(cwd, options.publicDir) : sourceDir;
  const destinationDir = path.resolve(cwd, options.destination);
  const generatedDir = path.join(cwd, INTERNAL_WORK_DIR);
  const stagingDir = path.join(cwd, STAGING_DIR);
  const previewDataPath = path.join(cwd, PREVIEW_DATA_PATH);
  const themeDir = resolveThemeDir(cwd, options);

  await assertBuildPagesPathLayout({
    cwd,
    sourceDir,
    publicDir,
    publicDirExplicit,
    destinationDir,
    themeDir,
    generatedDir,
  });
  await assertSourceDirectory(sourceDir);
  await assertDirectory(themeDir, 'Theme directory');
  await assertPublicDirectory(publicDir, publicDirExplicit);
  await assertDestinationPath(destinationDir);
  const themeId = await readThemeId(themeDir);
  await fs.rm(generatedDir, { recursive: true, force: true });

  const env = {
    ...process.env,
    ZEROPRESS_BUILD_PAGES_SOURCE: sourceDir,
    ZEROPRESS_BUILD_PAGES_PUBLIC_DIR: publicDir,
    ZEROPRESS_PUBLIC_DIR: publicDir,
    ZEROPRESS_SKIP_UNTITLED_MARKDOWN: String(Boolean(options.skipUntitledMarkdown)),
    ZEROPRESS_COPY_MARKDOWN_SOURCE: String(copyMarkdownSource),
    ZEROPRESS_BUILD_PAGES_THEME_ID: themeId,
  };
  delete env.ZEROPRESS_BUILD_PAGES_CONFIG;
  delete env.ZEROPRESS_SITE_URL;
  if (options.config) {
    env.ZEROPRESS_BUILD_PAGES_CONFIG = path.resolve(cwd, options.config);
  }
  if (options.siteUrl) {
    env.ZEROPRESS_SITE_URL = options.siteUrl;
  }

  const prebuild = spawnSync(process.execPath, [prebuildScript], {
    cwd,
    env,
    encoding: 'utf8',
  });
  process.stdout.write(prebuild.stdout || '');
  process.stderr.write(prebuild.stderr || '');
  if (prebuild.status !== 0) {
    if (prebuild.stderr) {
      process.stderr.write('\n');
    }
    throw new Error('Build pages prebuild failed.');
  }

  const previewData = JSON.parse(await fs.readFile(previewDataPath, 'utf8'));
  await fs.rm(destinationDir, { recursive: true, force: true });
  await fs.rm(stagingDir, { recursive: true, force: true });
  await fs.mkdir(stagingDir, { recursive: true });
  await copyPublicStaging(publicDir, stagingDir, {
    excludePaths: [destinationDir, themeDir, generatedDir],
    copyMarkdownSource,
  });
  if (copyMarkdownSource) {
    await copySourceMarkdownFiles(sourceDir, stagingDir, previewData);
  }

  const previousPublicDir = process.env.ZEROPRESS_PUBLIC_DIR;
  process.env.ZEROPRESS_PUBLIC_DIR = stagingDir;
  try {
    const result = await runBuild(themeDir, previewData, destinationDir, { generateFeed: false });
    console.log('');
    console.log(formatBuildPagesSuccessMessage());
    console.log(`Files: ${result.files.length}`);
    console.log(`Output: ${formatPath(cwd, destinationDir)}`);
  } finally {
    if (previousPublicDir === undefined) {
      delete process.env.ZEROPRESS_PUBLIC_DIR;
    } else {
      process.env.ZEROPRESS_PUBLIC_DIR = previousPublicDir;
    }
  }

  if (!options.skipLinkCheck) {
    const result = await checkInternalLinks(destinationDir);
    if (result.brokenLinks.length) {
      console.warn('Warning: broken internal links found:');
      for (const link of result.brokenLinks) {
        console.warn(`- ${toTerminalSafeText(link)}`);
      }
    }
    console.log(`Checked ${result.htmlFiles.length} HTML files for internal links`);
  }
}

async function readPackageJson() {
  return JSON.parse(await fs.readFile(path.join(packageDir, 'package.json'), 'utf8'));
}

async function readThemeId(themeDir) {
  const themeJsonPath = path.join(themeDir, 'theme.json');
  let rawThemeJson;
  try {
    rawThemeJson = await fs.readFile(themeJsonPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Theme manifest not found: ${themeJsonPath}`);
    }
    throw error;
  }

  let manifest;
  try {
    manifest = JSON.parse(rawThemeJson);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Theme manifest is not valid JSON: ${themeJsonPath}\nReason: ${message}`);
  }

  const namespace = typeof manifest.namespace === 'string' ? manifest.namespace.trim() : '';
  const slug = typeof manifest.slug === 'string' ? manifest.slug.trim() : '';
  const version = typeof manifest.version === 'string' ? manifest.version.trim() : '';

  if (!namespace || !slug || !version) {
    throw new Error(`Theme manifest must include namespace, slug, and version: ${themeJsonPath}`);
  }

  return `${namespace}.${slug}@${version}`;
}

function formatDocsUrl(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

export function parseArgs(argv) {
  const flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--skip-untitled-markdown') {
      flags.skipUntitledMarkdown = true;
      continue;
    }
    if (arg === '--skip-link-check') {
      flags.skipLinkCheck = true;
      continue;
    }
    if (arg === '--no-copy-markdown-source') {
      flags.copyMarkdownSource = false;
      continue;
    }

    const valueOptions = new Set([
      '--source',
      '--public-dir',
      '--destination',
      '--theme',
      '--theme-path',
      '--config',
      '--site-url',
    ]);
    if (valueOptions.has(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Invalid arguments: ${arg} requires a value`);
      }
      flags[arg.slice(2)] = value;
      index += 1;
      continue;
    }

    if (!arg.startsWith('--')) {
      throw new Error(`Invalid arguments: unexpected positional argument: ${arg}. Use --source <dir> and --destination <dir>.`);
    }

    throw new Error(`Invalid arguments: unknown option ${arg}`);
  }

  const source = flags.source || '';
  const destination = flags.destination || '';
  if (!source) {
    throw new Error('Invalid arguments: --source <dir> is required.');
  }
  if (!destination) {
    throw new Error('Invalid arguments: --destination <dir> is required.');
  }

  return {
    source,
    publicDir: flags['public-dir'] || '',
    destination,
    theme: flags.theme || DEFAULT_THEME,
    themePath: flags['theme-path'] || '',
    config: flags.config || '',
    siteUrl: flags['site-url'] || '',
    skipUntitledMarkdown: flags.skipUntitledMarkdown === true,
    skipLinkCheck: flags.skipLinkCheck === true,
    copyMarkdownSource: flags.copyMarkdownSource !== false,
  };
}

function printHelp() {
  console.log(`zeropress-build-pages - Build ZeroPress static output for modern hosting platforms

Usage:
  zeropress-build-pages [options]

Options:
  --source <dir>                Dedicated source directory (required)
  --public-dir <dir>            Public passthrough directory (default: source)
  --destination <dir>           Output directory (required)
  --theme docs                  Bundled theme name (default: docs; available: docs, docs1, docs2, plain)
  --theme-path <dir>            Custom ZeroPress theme directory
  --config <path>               Config file (default: <source>/.zeropress/config.json)
  --site-url <url>              Origin-root canonical URL override (no subdirectory path)
  --skip-untitled-markdown      Skip Markdown files without a page title
  --skip-link-check             Skip internal link checking
  --no-copy-markdown-source     Do not copy original Markdown files to output
  --help, -h                    Show help
  --version, -v                 Show version`);
}

function prefixError(message) {
  if (message.startsWith('[zeropress-build-pages]')) {
    return message;
  }
  return `[zeropress-build-pages] ${message}`;
}

export function formatBuildPagesSuccessMessage(stream = process.stdout) {
  return createColor(stream).green('Built ZeroPress Pages site successfully');
}

export function formatBuildPagesBanner(version, stream = process.stdout) {
  return createColor(stream).cyanBold(`ZeroPress Build Pages ${version}`);
}

function colorizeError(message) {
  if (!colorsEnabled(process.stderr)) {
    return message;
  }

  return message
    .replace(/^(\[zeropress-build-pages\].*)/m, '\x1b[31m$1\x1b[0m')
    .replace(/\bERROR\b/g, '\x1b[31mERROR\x1b[0m')
    .replace(/\bWARN\b/g, '\x1b[33mWARN\x1b[0m')
    .replace(/\bHint:/g, '\x1b[1mHint:\x1b[0m');
}

function createColor(stream) {
  const enabled = colorsEnabled(stream);
  const wrap = (code, value) => (enabled ? `\x1b[${code}m${value}\x1b[0m` : value);
  return {
    red: (value) => wrap('31', value),
    yellow: (value) => wrap('33', value),
    green: (value) => wrap('32', value),
    cyanBold: (value) => wrap('1;36', value),
  };
}

function colorsEnabled(stream) {
  if (process.env.NO_COLOR) {
    return false;
  }
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') {
    return true;
  }
  return Boolean(stream?.isTTY);
}

function resolveThemeDir(cwd, options) {
  if (options.themePath) {
    return path.resolve(cwd, options.themePath);
  }
  const canonicalTheme = BUNDLED_THEME_ALIASES.get(options.theme);
  if (canonicalTheme) {
    return path.join(packageDir, 'themes', canonicalTheme);
  }
  throw new Error(`Unknown bundled theme: ${options.theme}. Supported bundled themes: ${Array.from(BUNDLED_THEME_ALIASES.keys()).join(', ')}`);
}

function hasExplicitPublicDir(options) {
  return typeof options.publicDir === 'string' && Boolean(options.publicDir.trim());
}

async function assertDirectory(dir, label) {
  let stat;
  try {
    stat = await fs.stat(dir);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`${label} not found: ${dir}`);
    }
    throw error;
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label} is not a directory: ${dir}`);
  }
}

async function assertSourceDirectory(sourceDir) {
  let stat;
  try {
    stat = await fs.lstat(sourceDir);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Source directory not found: ${sourceDir}`);
    }
    throw error;
  }

  if (stat.isSymbolicLink()) {
    throw new Error(`Source directory must not be a symbolic link: ${sourceDir}`);
  }

  if (!stat.isDirectory()) {
    throw new Error(`Source directory is not a directory: ${sourceDir}`);
  }
}

async function assertPublicDirectory(publicDir, explicit) {
  if (!explicit) {
    return;
  }

  let stat;
  try {
    stat = await fs.lstat(publicDir);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Public directory not found: ${publicDir}`);
    }
    throw error;
  }

  if (stat.isSymbolicLink()) {
    throw new Error(`Public directory must not be a symbolic link: ${publicDir}`);
  }

  if (!stat.isDirectory()) {
    throw new Error(`Public path is not a directory: ${publicDir}`);
  }
}

async function assertDestinationPath(destinationDir) {
  let stat;
  try {
    stat = await fs.lstat(destinationDir);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return;
    }
    throw error;
  }

  if (!stat.isDirectory()) {
    throw new Error(`Destination path is not a directory: ${destinationDir}`);
  }
}

async function assertBuildPagesPathLayout({
  cwd,
  sourceDir,
  publicDir,
  publicDirExplicit,
  destinationDir,
  themeDir,
  generatedDir,
}) {
  const [
    canonicalCwd,
    canonicalSourceDir,
    canonicalPublicDir,
    canonicalDestinationDir,
    canonicalThemeDir,
    canonicalGeneratedDir,
  ] = await Promise.all([
    resolveCanonicalPath(cwd),
    resolveCanonicalPath(sourceDir),
    resolveCanonicalPath(publicDir),
    resolveCanonicalPath(destinationDir),
    resolveCanonicalPath(themeDir),
    resolveCanonicalPath(generatedDir),
  ]);

  if (samePath(canonicalSourceDir, canonicalCwd)) {
    throw new Error(
      'Source directory must be a dedicated content directory, not the current working directory. '
      + `Received: ${formatPath(cwd, sourceDir)}`,
    );
  }

  if (publicDirExplicit && samePath(canonicalPublicDir, canonicalCwd)) {
    throw new Error(
      'Public directory must be a dedicated asset directory, not the current working directory. '
      + `Received: ${formatPath(cwd, publicDir)}`,
    );
  }

  assertNoPathOverlap(
    cwd,
    'Source directory',
    sourceDir,
    `internal ${INTERNAL_WORK_DIR} working directory`,
    generatedDir,
    canonicalSourceDir,
    canonicalGeneratedDir,
  );
  assertNoPathOverlap(
    cwd,
    'Destination directory',
    destinationDir,
    `internal ${INTERNAL_WORK_DIR} working directory`,
    generatedDir,
    canonicalDestinationDir,
    canonicalGeneratedDir,
  );
  assertNoPathOverlap(
    cwd,
    'Theme directory',
    themeDir,
    `internal ${INTERNAL_WORK_DIR} working directory`,
    generatedDir,
    canonicalThemeDir,
    canonicalGeneratedDir,
  );
  assertNoPathOverlap(
    cwd,
    'Theme directory',
    themeDir,
    'destination directory',
    destinationDir,
    canonicalThemeDir,
    canonicalDestinationDir,
  );
  if (!samePath(canonicalPublicDir, canonicalSourceDir)) {
    assertNoPathOverlap(
      cwd,
      'Public directory',
      publicDir,
      `internal ${INTERNAL_WORK_DIR} working directory`,
      generatedDir,
      canonicalPublicDir,
      canonicalGeneratedDir,
    );
    assertNoPathOverlap(
      cwd,
      'Public directory',
      publicDir,
      'destination directory',
      destinationDir,
      canonicalPublicDir,
      canonicalDestinationDir,
    );
    assertNoPathOverlap(
      cwd,
      'Public directory',
      publicDir,
      'theme directory',
      themeDir,
      canonicalPublicDir,
      canonicalThemeDir,
    );
  }
  assertNoPathOverlap(
    cwd,
    'Source directory',
    sourceDir,
    'destination directory',
    destinationDir,
    canonicalSourceDir,
    canonicalDestinationDir,
  );
  assertNoPathOverlap(
    cwd,
    'Source directory',
    sourceDir,
    'theme directory',
    themeDir,
    canonicalSourceDir,
    canonicalThemeDir,
  );
  assertSourceIsNotInsidePublicDirectory(
    cwd,
    sourceDir,
    publicDir,
    canonicalSourceDir,
    canonicalPublicDir,
  );
}

function assertSourceIsNotInsidePublicDirectory(
  cwd,
  sourceDir,
  publicDir,
  comparisonSourceDir = sourceDir,
  comparisonPublicDir = publicDir,
) {
  if (
    samePath(comparisonSourceDir, comparisonPublicDir)
    || !isPathInside(comparisonPublicDir, comparisonSourceDir)
  ) {
    return;
  }

  throw new Error(
    'Source directory must not be inside the public directory. '
    + `Source directory: ${formatPath(cwd, sourceDir)}; `
    + `Public directory: ${formatPath(cwd, publicDir)}`,
  );
}

function assertNoPathOverlap(
  cwd,
  firstLabel,
  firstPath,
  secondLabel,
  secondPath,
  comparisonFirstPath = firstPath,
  comparisonSecondPath = secondPath,
) {
  if (!pathsOverlap(comparisonFirstPath, comparisonSecondPath)) {
    return;
  }
  throw new Error(
    `${firstLabel} must not overlap the ${secondLabel}. `
    + `${firstLabel}: ${formatPath(cwd, firstPath)}; `
    + `${secondLabel}: ${formatPath(cwd, secondPath)}`,
  );
}

async function copyPublicStaging(sourceDir, targetDir, options) {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    if (shouldIgnorePublicEntry(entry.name) || entry.isSymbolicLink()) {
      continue;
    }

    const sourcePath = path.join(sourceDir, entry.name);
    if (isExcludedPath(sourcePath, options.excludePaths)) {
      continue;
    }

    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(targetPath, { recursive: true });
      await copyPublicStaging(sourcePath, targetPath, options);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (options.copyMarkdownSource === false && entry.name.toLowerCase().endsWith('.md')) {
      continue;
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
  }
}

async function copySourceMarkdownFiles(sourceDir, targetDir, previewData) {
  const markdownUrls = new Set();

  for (const page of previewData?.content?.pages || []) {
    const sourceMarkdownUrl = page?.meta?.source_markdown_url;
    if (typeof sourceMarkdownUrl === 'string' && sourceMarkdownUrl) {
      markdownUrls.add(sourceMarkdownUrl);
    }
  }

  for (const sourceMarkdownUrl of markdownUrls) {
    const relativePath = sourceMarkdownUrlToRelativePath(sourceMarkdownUrl);
    if (!relativePath) {
      continue;
    }

    const sourcePath = path.join(sourceDir, relativePath);
    if (!isPathInside(sourceDir, sourcePath)) {
      continue;
    }

    const targetPath = path.join(targetDir, relativePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
  }
}

function sourceMarkdownUrlToRelativePath(sourceMarkdownUrl) {
  if (
    !sourceMarkdownUrl.startsWith('/')
    || sourceMarkdownUrl.includes('?')
    || sourceMarkdownUrl.includes('#')
  ) {
    return '';
  }

  const rawSegments = sourceMarkdownUrl.slice(1).split('/');
  const segments = [];
  for (const rawSegment of rawSegments) {
    if (!rawSegment) {
      return '';
    }

    let segment;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      return '';
    }

    if (!segment || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\')) {
      return '';
    }

    segments.push(segment);
  }

  const relativePath = segments.join('/');
  return relativePath.toLowerCase().endsWith('.md') ? relativePath : '';
}

function shouldIgnorePublicEntry(name) {
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

function isExcludedPath(candidate, excludePaths) {
  return excludePaths.some((excludePath) => pathsOverlap(candidate, excludePath));
}

function pathsOverlap(firstPath, secondPath) {
  const first = path.resolve(firstPath);
  const second = path.resolve(secondPath);
  return first === second || isPathInside(first, second) || isPathInside(second, first);
}

function samePath(firstPath, secondPath) {
  return path.resolve(firstPath) === path.resolve(secondPath);
}

function isPathInside(parentPath, childPath) {
  const relativePath = path.relative(parentPath, childPath);
  return Boolean(relativePath) && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

async function resolveCanonicalPath(targetPath) {
  let existingPath = path.resolve(targetPath);
  const unresolvedSegments = [];

  while (true) {
    try {
      const realPath = await fs.realpath(existingPath);
      return path.resolve(realPath, ...unresolvedSegments);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
        throw error;
      }

      const parentPath = path.dirname(existingPath);
      if (parentPath === existingPath) {
        throw error;
      }

      unresolvedSegments.unshift(path.basename(existingPath));
      existingPath = parentPath;
    }
  }
}

function formatPath(cwd, targetPath) {
  const relativePath = path.relative(cwd, targetPath);
  const displayPath = relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)
    ? relativePath.replace(/\\/g, '/')
    : targetPath.replace(/\\/g, '/');
  return toTerminalSafeText(displayPath);
}
