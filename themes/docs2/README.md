# ZeroPress Template Docs2

Docs2 is a bundled documentation theme for `@zeropress/build-pages`. It is
intended for larger Markdown-source documentation sites that need a persistent
sidebar, command palette search, page table of contents, and collection-based
previous/next navigation.

This README is human-facing theme documentation. ZeroPress does not interpret it
as runtime configuration.

## Usage

Use Docs2 with the bundled theme name:

```bash
zeropress-build-pages --source ./docs --destination ./_site --theme docs2
```

Docs2 is a separate bundled theme, not an alias for `docs`.

## Intended Use

Docs2 works best for:

- product documentation
- CLI manuals
- technical guides
- project documentation with multiple sections
- documentation sites that benefit from a sidebar and previous/next reading flow

For a simpler top-navigation documentation site, use `docs`.

## Expected Site Data

Docs2 is designed to work with Build Pages config and mostly front-matter-free
Markdown. The following data shapes are useful:

- `site.title`: rendered as the site brand
- `site.description`: used by generated metadata
- `site.logo`: optional brand image
- `menus.primary`: sidebar navigation
- `menus.footer`: footer links
- `collections`: optional reading-order groups
- `site.search`: enables command palette search and search artifacts
- `page.updated_at_iso` / `post.updated_at_iso`: optional update metadata

Docs2 intentionally does not declare `collection_slots` in `theme.json`.
It uses the generic `page.collection_cursor` and `post.collection_cursor`
aliases, so any collection id can provide previous/next navigation.

## Sidebar Navigation

`menus.primary` is rendered as the sidebar.

- top-level menu items with children become collapsible sidebar groups
- up to two child levels are rendered as page links
- deeper children are not rendered
- `item.meta.accent` may be used for group accent color

The sidebar marks the active page using route-aware template comparisons. If the
active page is inside a collapsed group, the client script opens that group.

## Collections And Pager

Docs2 renders previous/next links from:

- `page.collection_cursor`
- `post.collection_cursor`

Build Pages can generate collections from source-relative Markdown paths in
config. The first matching collection supplies the generic cursor alias; all
named cursors remain available through `collection_cursors`.

The previous/next pager does not cross collection boundaries.

## Search

Docs2 uses a command palette search UI. The UI imports `/_zeropress/search.js`,
which means it can use either the ZeroPress native adapter or the Pagefind
adapter replacement flow documented by Build Pages.

The post/page body wrapper includes `data-pagefind-body` when search is enabled
and the route is not `discoverability: "delist"`.

Search result navigation can pass a `q` query parameter. The theme progressively
enhances matching text in the target document and provides a small clear action.

## Markdown

Docs2 styles common Markdown and GFM output, including:

- headings and generated table of contents
- tables with alignment classes
- task lists
- GitHub-style alerts
- fenced code blocks highlighted by ZeroPress build-core
- Mermaid code fences as progressive enhancement

Markdown is the source of the page H1. If the Markdown body includes an H1, the
theme renders that H1.

## Mermaid

Mermaid rendering is optional progressive enhancement. The theme detects Mermaid
code fences in the client and lazy-loads the pinned Mermaid runtime from
jsDelivr with SRI. Without JavaScript or if the runtime fails to load, the source
code fence remains visible.

## Color Theme

Docs2 supports light and dark modes with a two-state toggle after first user
selection. If no preference is stored, the initial mode follows the system color
scheme. The head partial applies the initial mode early to reduce flash during
page load.

## Source Markdown And Updated Date

When Build Pages copies Markdown source files, the theme renders a
`View as Markdown` link using `page.meta.source_markdown_url` or
`post.meta.source_markdown_url`.

When a route has `updated_at_iso`, Docs2 renders an `Updated` time element with
the ISO timestamp in the `datetime` and `title` attributes. The client script may
progressively enhance the displayed date for the visitor's locale.

## Footer

`menus.footer` is rendered in the footer. The footer also supports
`site.footer.copyright_text` and the standard ZeroPress attribution controlled by
`site.footer.attribution`.
