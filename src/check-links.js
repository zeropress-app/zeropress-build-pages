import fs from 'node:fs/promises';
import path from 'node:path';

export async function checkInternalLinks(siteDir) {
  const htmlFiles = await listFiles(siteDir, (filePath) => filePath.endsWith('.html'));
  const brokenLinks = [];

  for (const filePath of htmlFiles) {
    const html = await fs.readFile(filePath, 'utf8');
    const links = extractInternalLinks(html);

    for (const link of links) {
      if (!(await linkExists(siteDir, link))) {
        brokenLinks.push(`${path.relative(siteDir, filePath)} -> ${link}`);
      }
    }
  }

  return {
    htmlFiles,
    brokenLinks,
  };
}

async function listFiles(dir, predicate) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(filePath, predicate));
      continue;
    }

    if (entry.isFile() && predicate(filePath)) {
      files.push(filePath);
    }
  }

  return files;
}

function extractInternalLinks(html) {
  const links = [];
  const pattern = /\b(?:href|src)="([^"]+)"/g;
  let match;

  while ((match = pattern.exec(html)) !== null) {
    const raw = match[1].trim();
    if (
      !raw
      || raw.startsWith('#')
      || /^[a-z][a-z0-9+.-]*:/i.test(raw)
      || raw.startsWith('//')
    ) {
      continue;
    }

    links.push(stripHashAndQuery(raw));
  }

  return links.filter(Boolean);
}

function stripHashAndQuery(link) {
  return link.split('#')[0].split('?')[0];
}

async function linkExists(siteDir, link) {
  const relativePath = decodeURIComponent(link.replace(/^\/+/, ''));
  const candidates = link.endsWith('/')
    ? [path.join(siteDir, relativePath, 'index.html')]
    : [
      path.join(siteDir, relativePath),
      path.join(siteDir, `${relativePath}.html`),
      path.join(siteDir, relativePath, 'index.html'),
    ];

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        return true;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  return false;
}
