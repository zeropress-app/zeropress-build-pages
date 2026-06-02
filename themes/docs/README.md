# ZeroPress Template Docs1

Docs1 is the default bundled documentation theme for `@zeropress/build-pages`.
It is intended for small documentation sites that need a clean top navigation,
readable Markdown output, native static search, and light/dark mode support
without requiring a custom theme.

This README is human-facing theme documentation. ZeroPress does not interpret it
as runtime configuration.

## Usage

Use Docs1 through either bundled theme name:

```bash
zeropress-build-pages --source ./docs --destination ./_site --theme docs
```

```bash
zeropress-build-pages --source ./docs --destination ./_site --theme docs1
```

`docs` is the canonical default bundled theme name. `docs1` is an alias for the
same theme.

## Intended Use

Docs1 works best for:

- project documentation
- package manuals
- short guides
- reference pages with a small primary navigation

For a larger documentation site with a persistent sidebar, command palette, and
collection-based previous/next navigation, use `docs2`.

## Expected Site Data

Docs1 expects ordinary Build Pages output and can be used with minimal config.
The following fields improve the result:

- `site.title`: rendered as the brand label
- `site.description`: used by generated metadata and the front page
- `site.logo`: optional brand image
- `menus.primary`: top-level navigation links
- `menus.footer`: compact footer links
- `site.search`: enables the bundled search form and ZeroPress search artifacts

The theme does not require collections, widgets, or custom front matter.

## Navigation

`menus.primary` is rendered in the header through the built-in menu helper.
Keep it short. Docs1 is designed for a small number of top-level sections rather
than a deep sidebar tree.

`menus.footer` is rendered in the footer.

## Search

Docs1 uses ZeroPress native static search when `site.search` is enabled.
The search UI imports `/_zeropress/search.js`, so it can also use the Pagefind
adapter flow documented by Build Pages.

The post/page body wrapper includes `data-pagefind-body` when search is enabled
and the route is not `discoverability: "delist"`.

## Markdown

Docs1 styles common Markdown and GFM output, including:

- headings and table of contents
- tables
- task lists
- GitHub-style alerts
- fenced code blocks highlighted by ZeroPress build-core

Markdown is the source of the page H1. If the Markdown body includes an H1, the
theme renders that H1.

## Color Theme

Docs1 includes a light/dark toggle. The initial theme is applied early in the
head to reduce flash during page load. Without JavaScript, the page still renders
as a readable document.

## Source Markdown Links

When Build Pages copies Markdown source files, the theme renders a
`View this page as Markdown` link using `page.meta.source_markdown_url` or
`post.meta.source_markdown_url`.
