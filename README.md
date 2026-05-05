# @zeropress/build-pages

Build ZeroPress static output for modern hosting platforms.

`@zeropress/build-pages` turns a directory of Markdown files and public assets into static ZeroPress output. It discovers Markdown files, converts them to preview-data v0.5, stages public files, and runs `@zeropress/build`.

The generated output is plain static files that can be deployed to GitHub Pages, Cloudflare Pages, Netlify, Vercel, or any static hosting provider.

## GitHub Action

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/configure-pages@v5
      - name: Build ZeroPress Pages
        uses: zeropress-app/zeropress-build-pages@v0
        with:
          source: ./
          destination: ./_site
          theme: docs
      - uses: actions/upload-pages-artifact@v3
        with:
          path: ./_site
```

The action builds the static files only. Uploading and deploying are handled by your hosting provider's deployment action or CLI.

For GitHub Pages, the generated `destination` directory can be passed to `actions/upload-pages-artifact`. For Cloudflare Pages, Netlify, Vercel, or another static host, pass the same `destination` directory to that provider's deploy step.

## CLI

```bash
npx @zeropress/build-pages --source ./docs --destination ./_site
```

Options:

| Option | Default | Purpose |
| --- | --- | --- |
| `--source <dir>` | `.` | Source directory containing Markdown and public files |
| `--destination <dir>` | `_site` | Output directory |
| `--out <dir>` | `_site` | Alias for `--destination` |
| `--theme docs` | `docs` | Bundled docs theme |
| `--theme-path <dir>` | none | Custom ZeroPress theme directory |
| `--config <path>` | `<source>/.zeropress/config.json` | Build Pages config |
| `--site-url <url>` | config `site.url` | Canonical URL override |
| `--skip-untitled-markdown` | `false` | Skip Markdown without an H1 |
| `--check-links` | `true` | Warn about broken internal links |
| `--no-check-links` | false | Skip link checking |

Equivalent environment variables:

| Env | Maps to |
| --- | --- |
| `ZEROPRESS_PUBLIC_DIR` | `--source` |
| `ZEROPRESS_OUT_DIR` | `--destination` |
| `ZEROPRESS_THEME_DIR` | `--theme-path` |
| `ZEROPRESS_BUILD_PAGES_CONFIG` | `--config` |
| `ZEROPRESS_SITE_URL` | `--site-url` |
| `ZEROPRESS_SKIP_UNTITLED_MARKDOWN=true` | `--skip-untitled-markdown` |

CLI options take precedence over environment variables.

## Source Tree

The source directory is both the Markdown source root and the public passthrough root.

```txt
docs/
  index.md
  guide.md
  assets/
  .zeropress/
    config.json
```

Build Pages stages the source tree before calling `@zeropress/build`, so `--source ./` and `--destination ./_site` are supported. Generated ZeroPress output wins over staged public files.

Ignored while staging and Markdown discovery:

- hidden paths such as `.git`, `.env`, and `.zeropress`
- `node_modules`
- `Thumbs.db`
- `*.key`
- `*.pem`
- symlinks

Additional Markdown discovery ignores:

- path segments starting with `_`
- path segments starting with `#`
- path segments ending with `~`
- `vendor`

## Markdown Discovery

- `*.md` files are discovered recursively.
- Each Markdown page needs an ATX H1 (`# Title`) or Setext H1 (`Title` + `====`).
- Missing or empty H1 fails the build unless `--skip-untitled-markdown` is used.
- Root `index.md` becomes the front page when no config is present.
- Nested `index.md` maps to a directory route, such as `cli/index.md` -> `/cli/`.
- Other Markdown files map to extensionless routes, such as `cli/tool.md` -> `/cli/tool`.
- Markdown links to other discovered `.md` files are rewritten to generated public URLs.
- Original Markdown files remain available as public passthrough files.

## Config

Build Pages reads `<source>/.zeropress/config.json` when present. Missing config falls back to defaults.

```json
{
  "$schema": "../schemas/zeropress-build-pages.config.v0.1.schema.json",
  "version": "0.1",
  "site": {
    "title": "My Docs",
    "description": "Project documentation",
    "url": "https://example.github.io/project",
    "footer": {
      "copyright_text": "Copyright 2026 Example Corp.",
      "attribution": {
        "enabled": true
      }
    }
  },
  "front_page": {
    "type": "markdown"
  },
  "menus": {
    "primary": {
      "name": "Primary Menu",
      "items": [
        { "title": "Home", "url": "/" },
        { "title": "Guide", "url": "/guide" }
      ]
    }
  },
  "custom_html": {
    "head_end": { "file": ".zeropress/head-end.html" },
    "body_end": { "file": ".zeropress/body-end.html" }
  }
}
```

`front_page` modes:

- `{ "type": "theme_index" }`: render bundled theme home.
- `{ "type": "markdown" }`: render `index.md` through `page.html`.
- `{ "type": "html" }`: render `.zeropress/index.html` through `page.html`.
- `{ "type": "html", "layout": false }`: write trusted standalone HTML directly.

HTML front page and `custom_html` files must stay inside `.zeropress/`.

`site.footer.copyright_text` is rendered by the bundled docs theme when present. If it is omitted, the bundled docs theme falls back to `site.title`. ZeroPress does not add a copyright symbol automatically.

The bundled docs theme shows `Published with ZeroPress.` by default. Set `site.footer.attribution.enabled` to `false` to hide it.

Schemas:

- `schemas/zeropress-build-pages.config.v0.1.schema.json`
- `schemas/zeropress-build-pages.config.schema.json`

## Generated Files

Build Pages writes:

```txt
.zeropress/
  preview-data.json
  prebuild-report.json
  build-pages-public/
```

`preview-data.json` is the generated preview-data v0.5 input passed to `@zeropress/build`.

## Development

```bash
npm install
npm run build:action
npm test
```
