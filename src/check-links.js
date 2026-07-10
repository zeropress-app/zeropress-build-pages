import fs from 'node:fs/promises';
import path from 'node:path';

export async function checkInternalLinks(siteDir) {
  const htmlFiles = await listFiles(siteDir, (filePath) => filePath.endsWith('.html'));
  const brokenLinks = [];

  for (const filePath of htmlFiles) {
    const html = await fs.readFile(filePath, 'utf8');
    const links = extractInternalLinks(html);

    for (const link of links) {
      if (!(await linkExists(siteDir, filePath, link))) {
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
  const pattern = /\b(href|src|poster|srcset)\s*=\s*(["'])(.*?)\2/gi;
  let match;

  while ((match = pattern.exec(html)) !== null) {
    const attrName = match[1].toLowerCase();
    const raw = match[3].trim();
    if (attrName === 'srcset') {
      for (const link of extractSrcsetLinks(raw)) {
        if (shouldCheckInternalLink(link)) {
          links.push(stripHashAndQuery(link));
        }
      }
      continue;
    }

    if (shouldCheckInternalLink(raw)) {
      links.push(stripHashAndQuery(raw));
    }
  }

  return links.filter(Boolean);
}

function extractSrcsetLinks(value) {
  return value
    .split(',')
    .map((candidate) => candidate.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function shouldCheckInternalLink(raw) {
  return !(
    !raw
    || raw.startsWith('#')
    || /^[a-z][a-z0-9+.-]*:/i.test(raw)
    || raw.startsWith('//')
  );
}

function stripHashAndQuery(link) {
  return link.split('#')[0].split('?')[0];
}

async function linkExists(siteDir, htmlFilePath, link) {
  const target = resolveLinkTarget(siteDir, htmlFilePath, link);
  if (!target || !isPathInside(siteDir, target)) {
    return false;
  }

  const candidates = link.endsWith('/')
    ? [path.join(target, 'index.html')]
    : [
      target,
      `${target}.html`,
      path.join(target, 'index.html'),
    ];

  for (const candidate of candidates) {
    if (!isPathInside(siteDir, candidate)) {
      continue;
    }

    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        return true;
      }
    } catch (error) {
      if (!isMissingLinkTargetError(error)) {
        throw error;
      }
    }
  }

  return false;
}

function resolveLinkTarget(siteDir, htmlFilePath, link) {
  let decodedLink;
  try {
    decodedLink = decodeURIComponent(link);
  } catch {
    return '';
  }
  if (decodedLink.includes('\0')) {
    return '';
  }

  if (decodedLink.startsWith('/')) {
    return path.resolve(siteDir, decodedLink.replace(/^\/+/, ''));
  }

  return path.resolve(path.dirname(htmlFilePath), decodedLink);
}

function isPathInside(parent, child) {
  const relativePath = path.relative(path.resolve(parent), path.resolve(child));
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function isMissingLinkTargetError(error) {
  return ['ENOENT', 'ENOTDIR', 'EINVAL', 'ENAMETOOLONG'].includes(error?.code);
}
