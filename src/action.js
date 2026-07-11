import { runBuildPages } from './index.js';
import { toTerminalSafeText } from './terminal.js';

try {
  const options = {
    source: input('source') || './docs',
    publicDir: input('public-dir'),
    destination: input('destination') || './_site',
    theme: input('theme') || 'docs',
    themePath: input('theme-path'),
    config: input('config'),
    siteUrl: input('site-url'),
    skipUntitledMarkdown: booleanInput('skip-untitled-markdown', false),
    skipLinkCheck: booleanInput('skip-link-check', false),
    copyMarkdownSource: booleanInput('copy-markdown-source', true),
  };

  await runBuildPages(options);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(toTerminalSafeText(message));
  process.exitCode = 1;
}

function input(name) {
  return process.env[`INPUT_${name.toUpperCase()}`]?.trim() || '';
}

function booleanInput(name, fallback) {
  const value = input(name);
  if (!value) {
    return fallback;
  }

  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }

  throw new Error(`Invalid boolean input "${name}": expected "true" or "false", received ${JSON.stringify(value)}.`);
}
