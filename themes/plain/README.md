# ZeroPress Plain

`zeropress.plain` is a minimal ZeroPress theme for small catalogs, one-page reference sites, and plain Markdown publishing.

It intentionally avoids search UI, navigation scaffolding, headers, footers, and site chrome. The theme renders each Markdown file as the page itself, with readable typography, responsive tables, code blocks, progressive heading anchors, Mermaid lazy loading, updated-date metadata, source Markdown links, and optional GitHub edit links.

## Best For

- README-style pages
- lightweight theme catalogs
- policy, license, and reference documents
- small Markdown pages where the document itself should be the entire page

This theme is not intended for multi-page documentation navigation. Use `zeropress.docs1` or `zeropress.docs2` when a site needs primary navigation, sidebar navigation, search UI, or collection-based previous/next links.

## Behavior

- Each Markdown file renders as a standalone document page.
- No header, footer, menu, hero, or search UI is rendered.
- `Updated` appears when Build Pages provides `page.updated_at_iso` or `post.updated_at_iso`.
- `View as Markdown` appears when Build Pages provides `page.meta.source_markdown_url`.
- `Improve this page` appears when `site.meta.edit_base_url` is configured, unless the page or post sets `meta.edit_link: false`.
- Heading anchors are added with progressive enhancement.
- Code blocks receive copy buttons with progressive enhancement.
- Tables remain readable without JavaScript and use table-level horizontal scrolling on small screens.
- Mermaid code fences remain readable without JavaScript and are rendered through lazy-loaded Mermaid when JavaScript is available.

## Optional Edit Links

Set `site.meta.edit_base_url` in Build Pages config to enable the edit link:

```json
{
  "site": {
    "meta": {
      "edit_base_url": "https://github.com/zeropress-app/example/edit/main/documents"
    }
  }
}
```

The value should point to the source directory in the repository and should not include a trailing slash. The theme appends `page.meta.source_markdown_url`, such as `/index.md`.

To hide the edit link on a specific page, set a scalar front matter meta flag:

```md
---
meta:
  edit_link: false
---
```

## Mermaid

Mermaid is not bundled into the theme asset. When a page contains a `mermaid` fenced code block and JavaScript is available, the theme lazy-loads the pinned Mermaid runtime from jsDelivr with Subresource Integrity.

Without JavaScript, the Mermaid fence remains visible as a normal code block.
