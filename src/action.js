import { runBuildPages } from './index.js';

const options = {
  source: input('source') || './',
  destination: input('destination') || './_site',
  theme: input('theme') || 'docs',
  themePath: input('theme-path'),
  config: input('config'),
  siteUrl: input('site-url'),
  skipUntitledMarkdown: booleanInput('skip-untitled-markdown', false),
  checkLinks: booleanInput('check-links', true),
};

try {
  await runBuildPages(options);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}

function input(name) {
  return process.env[`INPUT_${name.toUpperCase().replace(/-/g, '_')}`]?.trim() || '';
}

function booleanInput(name, fallback) {
  const value = input(name);
  if (!value) {
    return fallback;
  }
  return value.toLowerCase() === 'true';
}
