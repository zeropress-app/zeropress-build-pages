import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBuild } from '@zeropress/build/src/index.js';
import { checkInternalLinks } from './check-links.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, '..');
const prebuildScript = __dirname === path.join(packageDir, 'dist')
  ? path.join(__dirname, 'prebuild.js')
  : path.join(packageDir, 'src', 'prebuild.js');
const INTERNAL_WORK_DIR = '.zeropress-build-page';
const PREVIEW_DATA_PATH = `${INTERNAL_WORK_DIR}/preview-data.json`;
const STAGING_DIR = `${INTERNAL_WORK_DIR}/public-assets`;
const DEFAULT_THEME = 'docs';
const BUNDLED_THEME_ALIASES = new Map([
  ['docs', 'docs'],
  ['docs1', 'docs'],
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
    console.error(message);
    process.exitCode = 1;
  }
}

export async function runBuildPages(options) {
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

  assertBuildPagesPathLayout({
    cwd,
    sourceDir,
    publicDir,
    publicDirExplicit,
    destinationDir,
    themeDir,
    generatedDir,
  });
  await assertDirectory(sourceDir, 'Source directory');
  await assertDirectory(themeDir, 'Theme directory');
  await assertPublicDirectory(publicDir, publicDirExplicit);
  await assertDestinationPath(destinationDir);
  await fs.rm(generatedDir, { recursive: true, force: true });
  await fs.mkdir(generatedDir, { recursive: true });

  const env = {
    ...process.env,
    ZEROPRESS_BUILD_PAGES_SOURCE: sourceDir,
    ZEROPRESS_BUILD_PAGES_PUBLIC_DIR: publicDir,
    ZEROPRESS_PUBLIC_DIR: publicDir,
    ZEROPRESS_SKIP_UNTITLED_MARKDOWN: String(Boolean(options.skipUntitledMarkdown)),
    ZEROPRESS_COPY_MARKDOWN_SOURCE: String(copyMarkdownSource),
  };
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
    const result = await runBuild(themeDir, previewData, destinationDir);
    console.log('Built ZeroPress Pages site successfully');
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
        console.warn(`- ${link}`);
      }
    }
    console.log(`Checked ${result.htmlFiles.length} HTML files for internal links`);
  }
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
  --theme docs                  Bundled theme name (default: docs; docs1 aliases docs)
  --theme-path <dir>            Custom ZeroPress theme directory
  --config <path>               Config file (default: <source>/.zeropress/config.json)
  --site-url <url>              Canonical site URL override
  --skip-untitled-markdown      Skip Markdown files without a page title
  --skip-link-check             Skip internal link checking
  --no-copy-markdown-source     Do not copy original Markdown files to output
  --help, -h                    Show help
  --version, -v                 Show version`);
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

function assertBuildPagesPathLayout({
  cwd,
  sourceDir,
  publicDir,
  publicDirExplicit,
  destinationDir,
  themeDir,
  generatedDir,
}) {
  if (samePath(sourceDir, cwd)) {
    throw new Error(
      'Source directory must be a dedicated content directory, not the current working directory. '
      + `Received: ${formatPath(cwd, sourceDir)}`,
    );
  }

  if (publicDirExplicit && samePath(publicDir, cwd)) {
    throw new Error(
      'Public directory must be a dedicated asset directory, not the current working directory. '
      + `Received: ${formatPath(cwd, publicDir)}`,
    );
  }

  assertNoPathOverlap(cwd, 'Source directory', sourceDir, `internal ${INTERNAL_WORK_DIR} working directory`, generatedDir);
  assertNoPathOverlap(cwd, 'Destination directory', destinationDir, `internal ${INTERNAL_WORK_DIR} working directory`, generatedDir);
  assertNoPathOverlap(cwd, 'Theme directory', themeDir, `internal ${INTERNAL_WORK_DIR} working directory`, generatedDir);
  if (!samePath(publicDir, sourceDir)) {
    assertNoPathOverlap(cwd, 'Public directory', publicDir, `internal ${INTERNAL_WORK_DIR} working directory`, generatedDir);
    assertNoPathOverlap(cwd, 'Public directory', publicDir, 'destination directory', destinationDir);
    assertNoPathOverlap(cwd, 'Public directory', publicDir, 'theme directory', themeDir);
  }
  assertNoPathOverlap(cwd, 'Source directory', sourceDir, 'destination directory', destinationDir);
  assertNoPathOverlap(cwd, 'Source directory', sourceDir, 'theme directory', themeDir);
  assertSourceIsNotInsidePublicDirectory(cwd, sourceDir, publicDir);
}

function assertSourceIsNotInsidePublicDirectory(cwd, sourceDir, publicDir) {
  if (samePath(sourceDir, publicDir) || !isPathInside(publicDir, sourceDir)) {
    return;
  }

  throw new Error(
    'Source directory must not be inside the public directory. '
    + `Source directory: ${formatPath(cwd, sourceDir)}; `
    + `Public directory: ${formatPath(cwd, publicDir)}`,
  );
}

function assertNoPathOverlap(cwd, firstLabel, firstPath, secondLabel, secondPath) {
  if (!pathsOverlap(firstPath, secondPath)) {
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

function formatPath(cwd, targetPath) {
  const relativePath = path.relative(cwd, targetPath);
  return relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)
    ? relativePath.replace(/\\/g, '/')
    : targetPath.replace(/\\/g, '/');
}
