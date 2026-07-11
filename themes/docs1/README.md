# ZeroPress Docs (Top Nav)

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
- `site.search.enabled`: enables the bundled search form and ZeroPress search artifacts
- `page.updated_at_iso` / `post.updated_at_iso`: optional updated date display

The theme does not require collections, widgets, or custom front matter.

## Previous / Next Pager

When a page or post belongs to a Build Pages `collection`, Docs1 renders a
previous/next pager after the document body using `page.collection_cursor` or
`post.collection_cursor`. The pager follows the reading order defined by the
collection and does not cross collection boundaries. Pages that are not part of
any collection render without a pager, so collections are entirely optional.

## Navigation

`menus.primary` is rendered in the header as a short top-level navigation list.
Docs1 marks the current route during static rendering, so the active navigation
state works without JavaScript. On small screens the navigation collapses behind
a toggle that is driven by a CSS checkbox, so the menu opens and closes without
JavaScript as well. JavaScript only enhances it with ARIA state, Escape-to-close,
and focus return. Keep the menu short; Docs1 is designed for a small number of
top-level sections rather than a deep sidebar tree.

`menus.footer` is rendered in the footer.

## Search

Docs1 uses ZeroPress native static search when `site.search.enabled` is enabled.
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
- Mermaid fenced code blocks rendered as progressive enhancement

Markdown is the source of the page H1. If the Markdown body includes an H1, the
theme renders that H1.

Mermaid support is lazy loaded from a pinned jsDelivr runtime only when a page
contains `mermaid` fenced code blocks. Without JavaScript or if the runtime
cannot be loaded, the original code block remains visible.

## Color Theme

Docs1 includes a light/dark toggle. The initial theme is applied early in the
head to reduce flash during page load. Without JavaScript, the page still renders
as a readable document.

## Source Markdown Links

When Build Pages copies Markdown source files, the theme renders a
`View as Markdown` link using `page.meta.source_markdown_url` or
`post.meta.source_markdown_url`.

## Heading Anchors

Docs1 adds copy-link anchors to in-page headings (`h2`-`h4`) as progressive
enhancement. Build provides the heading `id` values; the anchors use them to
copy a deep link to the clipboard. Without JavaScript the headings render as
normal, with no extra anchor markup.

## Updated Dates

When Build Pages provides `page.updated_at_iso` or `post.updated_at_iso`, Docs1
renders a compact `Updated` line after the document body. JavaScript enhances the
date text with the visitor's locale while keeping the ISO timestamp in the
`title` attribute.
