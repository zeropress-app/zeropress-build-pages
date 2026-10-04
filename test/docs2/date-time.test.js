import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runBuild } from '@zeropress/build';

const template = fileURLToPath(new URL('../../themes/docs2/', import.meta.url));
const source = await fs.readFile(path.join(template, 'assets/theme.js'), 'utf8');
const timestamp = '2026-01-01T23:30:00Z';

function renderLocalTime({ dateStyle = 'long', timeStyle = 'short', locale = 'ko-KR', timezone = 'Asia/Seoul',
  datetime = timestamp, intlAvailable = true } = {}) {
  const calls = [];
  class TimeElement {
    textContent = 'Site-formatted date';
    attributes = new Map([['datetime', datetime]]);
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    setAttribute(name, value) { this.attributes.set(name, value); }
  }
  const time = new TimeElement();
  const browserIntl = intlAvailable ? {
    DateTimeFormat: function (requestedLocale, styles) {
      calls.push({ locale: requestedLocale, styles: { ...styles } });
      return new Intl.DateTimeFormat(requestedLocale ?? locale, { timeZone: timezone, ...styles });
    },
  } : undefined;
  const context = {
    Intl: browserIntl,
    HTMLTimeElement: TimeElement,
    URLSearchParams,
    localStorage: { getItem() { return null; }, setItem() {} },
    window: {
      Intl: browserIntl,
      location: { search: '', hash: '', pathname: '/', origin: 'https://site.example' },
      matchMedia() { return { matches: false, addEventListener() {} }; },
      addEventListener() {}, requestAnimationFrame() {},
    },
    document: {
      documentElement: {
        dataset: { zpDateStyle: dateStyle, zpTimeStyle: timeStyle },
        classList: { add() {} },
      },
      querySelector() { return null; },
      getElementById() { return null; },
      querySelectorAll(selector) { return selector === 'time[data-zp-local-date-time]' ? [time] : []; },
      addEventListener() {},
    },
  };
  vm.runInNewContext(source, context, { filename: 'docs2/theme.js' });
  return { time, calls };
}

test('docs2 respects site styles with browser language and timezone across date and DST boundaries', () => {
  for (const [dateStyle, timeStyle] of [['short', 'none'], ['long', 'short'], ['none', 'full']]) {
    const styles = {};
    if (dateStyle !== 'none') styles.dateStyle = dateStyle;
    if (timeStyle !== 'none') styles.timeStyle = timeStyle;
    for (const [locale, timezone] of [['ko-KR', 'Asia/Seoul'], ['en-US', 'America/New_York']]) {
      for (const datetime of [timestamp, '2026-07-01T23:30:00Z']) {
        const { time, calls } = renderLocalTime({ dateStyle, timeStyle, locale, timezone, datetime });
        assert.equal(time.textContent, new Intl.DateTimeFormat(locale, {
          ...styles, timeZone: timezone,
        }).format(new Date(datetime)));
        assert.equal(time.getAttribute('datetime'), datetime);
        assert.equal(time.getAttribute('title'), datetime);
        for (const call of calls) {
          assert.equal(call.locale, undefined, 'Use the browser language');
          assert.equal(Object.hasOwn(call.styles, 'timeZone'), false, 'Use the browser timezone');
        }
        assert.deepEqual(calls.at(-1).styles, styles);
      }
    }
  }
});

test('docs2 keeps disabled dates hidden and preserves fallback text when formatting is unavailable', () => {
  const hidden = renderLocalTime({ dateStyle: 'none', timeStyle: 'none' });
  assert.equal(hidden.time.textContent, '');
  assert.equal(hidden.calls.length, 0);
  for (const options of [{ intlAvailable: false }, { dateStyle: 'invalid-style' }, { datetime: 'invalid-date' }]) {
    assert.equal(renderLocalTime(options).time.textContent, 'Site-formatted date');
  }
});

test('docs2 renders both post and page dates with ISO metadata and a site-formatted fallback', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zp-docs2-dates-'));
  const publication = {
    version: '0.7', generator: 'date-time-test', generated_at: timestamp,
    site: { title: 'Sample publication', description: '', url: 'https://site.example',
      locale: 'en-US', timezone: 'UTC', media_origin: '', posts_per_page: 10,
      date_style: 'long', time_style: 'short', search: { enabled: false } },
    content: {
      authors: [{ id: 'sample-author', display_name: 'Sample Author' }],
      posts: [{ public_id: 1, title: 'Sample article', slug: 'sample', author_id: 'sample-author',
        document_type: 'markdown', content: 'Synthetic article.', excerpt: '', status: 'published',
        published_at_iso: timestamp, updated_at_iso: timestamp, category_slugs: [], tag_slugs: [] }],
      pages: [{ public_id: 2, title: 'Sample page', slug: 'about', document_type: 'markdown',
        content: 'Synthetic page.', status: 'published', updated_at_iso: timestamp }],
      categories: [], tags: [],
    },
    menus: {},
  };
  try {
    const fallback = new Intl.DateTimeFormat('en-US', {
      dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC',
    }).format(new Date(timestamp));
    for (const hidden of [false, true]) {
      const input = structuredClone(publication);
      if (hidden) Object.assign(input.site, { date_style: 'none', time_style: 'none' });
      const output = path.join(root, String(hidden));
      await runBuild(template, input, output);
      for (const route of ['posts/sample', 'about']) {
        const html = await fs.readFile(path.join(output, route, 'index.html'), 'utf8');
        assert.ok(html.includes(`data-zp-date-style="${input.site.date_style}"`));
        assert.ok(html.includes(`data-zp-time-style="${input.site.time_style}"`));
        if (hidden) {
          assert.doesNotMatch(html, /class="page-meta__updated"/);
        } else {
          assert.ok(html.includes(`datetime="${timestamp}" title="${timestamp}" data-zp-local-date-time>${fallback}</time>`));
        }
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the bundled Action includes the updated docs2 date runtime and markup', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zp-action-dates-'));
  try {
    await fs.mkdir(path.join(root, 'docs'));
    await fs.writeFile(path.join(root, 'docs/index.md'), `---\nupdated_at: "${timestamp}"\n---\n# Sample page\n`);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../dist/action.js', import.meta.url))], {
      cwd: root, encoding: 'utf8', env: {
        ...process.env, INPUT_SOURCE: 'docs', INPUT_DESTINATION: '_site', INPUT_THEME: 'docs2',
        'INPUT_SKIP-LINK-CHECK': 'true', NO_COLOR: '1', FORCE_COLOR: '0',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const output = path.join(root, '_site');
    const html = await fs.readFile(path.join(output, 'index.html'), 'utf8');
    assert.match(html, /data-zp-date-style="medium" data-zp-time-style="none"/);
    assert.match(html, /data-zp-local-date-time>/);
    const scriptPath = html.match(/<script[^>]+src="([^"]*\/theme(?:\.[a-f0-9]+)?\.js)"/u)?.[1];
    assert.ok(scriptPath, 'Expected the theme runtime');
    assert.equal(await fs.readFile(path.join(output, scriptPath.replace(/^\//, '')), 'utf8'), source);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
