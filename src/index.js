import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBuild } from '@zeropress/build/src/index.js';
import { checkInternalLinks } from './check-links.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, '..');
const prebuildScript = path.join(packageDir, 'src', 'prebuild.js');
const PREVIEW_DATA_PATH = '.zeropress/preview-data.json';
const STAGING_DIR = '.zeropress/public-assets';
const DEFAULT_THEME = 'docs';

export async function runCli(argv = process.argv.slice(2)) {
  try {
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
  const sourceDir = path.resolve(cwd, options.source);
  const destinationDir = path.resolve(cwd, options.destination);
  const generatedDir = path.join(cwd, '.zeropress');
  const stagingDir = path.join(cwd, STAGING_DIR);
  const previewDataPath = path.join(cwd, PREVIEW_DATA_PATH);
  const themeDir = resolveThemeDir(cwd, options);

  await assertDirectory(sourceDir, 'Source directory');
  await fs.rm(generatedDir, { recursive: true, force: true });
  await fs.mkdir(generatedDir, { recursive: true });

  const env = {
    ...process.env,
    ZEROPRESS_BUILD_PAGES_SOURCE: sourceDir,
    ZEROPRESS_PUBLIC_DIR: sourceDir,
    ZEROPRESS_SKIP_UNTITLED_MARKDOWN: String(Boolean(options.skipUntitledMarkdown)),
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
  await copyPublicStaging(sourceDir, stagingDir, {
    excludePaths: [destinationDir, themeDir, generatedDir],
  });

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

  if (options.checkLinks) {
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

export function parseArgs(argv, env = process.env) {
  const flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--skip-untitled-markdown') {
      flags.skipUntitledMarkdown = true;
      continue;
    }
    if (arg === '--check-links') {
      flags.checkLinks = true;
      continue;
    }
    if (arg === '--no-check-links') {
      flags.checkLinks = false;
      continue;
    }

    const valueOptions = new Set([
      '--source',
      '--destination',
      '--out',
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

  return {
    source: flags.source || env.ZEROPRESS_PUBLIC_DIR || '.',
    destination: flags.destination || flags.out || env.ZEROPRESS_OUT_DIR || '_site',
    theme: flags.theme || DEFAULT_THEME,
    themePath: flags['theme-path'] || env.ZEROPRESS_THEME_DIR || '',
    config: flags.config || env.ZEROPRESS_BUILD_PAGES_CONFIG || '',
    siteUrl: flags['site-url'] || env.ZEROPRESS_SITE_URL || '',
    skipUntitledMarkdown: flags.skipUntitledMarkdown ?? env.ZEROPRESS_SKIP_UNTITLED_MARKDOWN === 'true',
    checkLinks: flags.checkLinks ?? true,
  };
}

function printHelp() {
  console.log(`zeropress-build-pages - Build ZeroPress static output for modern hosting platforms

Usage:
  zeropress-build-pages [options]

Options:
  --source <dir>                Source directory (default: .)
  --destination <dir>           Output directory (default: _site)
  --out <dir>                   Alias for --destination
  --theme docs                  Bundled theme name (default: docs)
  --theme-path <dir>            Custom ZeroPress theme directory
  --config <path>               Config file (default: <source>/.zeropress/config.json)
  --site-url <url>              Canonical site URL override
  --skip-untitled-markdown      Skip Markdown files without an H1
  --check-links                 Warn about broken internal links (default)
  --no-check-links              Skip internal link checking
  --help, -h                    Show help
  --version, -v                 Show version`);
}

function resolveThemeDir(cwd, options) {
  if (options.themePath) {
    return path.resolve(cwd, options.themePath);
  }
  if (options.theme === DEFAULT_THEME) {
    return path.join(packageDir, 'themes', DEFAULT_THEME);
  }
  throw new Error(`Unknown bundled theme: ${options.theme}`);
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

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
  }
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
