# Epub Viewer

A clean, focused EPUB reader for Obsidian. Open EPUB, MOBI, AZW3, FB2, FBZ, CBZ and TXT; enjoy paginated or continuous scrolling, adjustable font size, reading themes, table of contents, full-text search, a bookshelf with progress, and reading-time tracking — without leaving your vault.

> Pure-reader philosophy: the plugin **never modifies your original book files** and **never writes any notes or annotations into your vault**. All reading progress lives only in the plugin's own `data.json`.

---

## Features

- **Multi-format support**: EPUB, MOBI, AZW3, FB2, FBZ, CBZ, TXT. Click any of these files in your vault to open it in the reader. Extension-to-view binding is conflict-guarded so it won't crash when another plugin also claims an extension.
- **Two page modes**: paginated and continuous scrolling. Set a default in settings or switch any time from the reader toolbar.
- **Font size**: toolbar `A-` / `A+` for instant changes, plus a 12–28px slider in settings (default 16px).
- **Reading themes (6)**: Follow Obsidian (auto-syncs via `MutationObserver` when the app theme changes), White, Warm, Green (eye-care), Sepia, and Dark. Pick any of them from the swatch dropdown in the toolbar.
- **Table of contents**: a collapsible TOC sidebar with title search and filtering, with the current chapter highlighted.
- **Full-text search**: a top search bar scans the entire book body, with a progress indicator.
- **Bookshelf view**: lists every ebook in your vault on the right sidebar. Each card shows:
  - a reading-progress bar and percentage
  - last-read time
  - accumulated reading time
  - estimated remaining minutes
- **Progress persistence**: your location (CFI / chapter / percentage / timestamp) is auto-saved to the plugin `data.json` and resumed on reopen, with debounced writes to avoid frequent I/O.
- **Reading-time tracking**: reading seconds are accumulated in the background and used to estimate remaining time on the bookshelf.
- **Internationalization**: Chinese (zh-cn) by default, falling back to English.
- **Mobile friendly**: tap/scroll paging toggle on mobile and an immersive mode that hides the bottom navigation bar while reading.

---

## Installation

### Option 1: Community Plugins (recommended, once published)
1. Open Obsidian Settings → Community plugins → Browse.
2. Search for **Epub Viewer**, then install and enable it.

### Option 2: BRAT beta
1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin.
2. Add the beta plugin repository `hellokunzai/obsidian-epub-viewer` via BRAT.

### Option 3: Manual
1. Download `main.js`, `manifest.json`, and `styles.css` from [Releases](https://github.com/hellokunzai/obsidian-epub-viewer/releases).
2. Place them in `YourVault/.obsidian/plugins/epub-viewer/` (create the folder if needed).
3. Enable **Epub Viewer** under Obsidian Settings → Community plugins.

---

## Usage

- **Open a book**: click any supported ebook file in the file list, or run the command "Open ebook bookshelf" (`open-epub-bookshelf`) from the command palette and pick from the shelf.
- **Paginate / scroll**: the paging button in the toolbar toggles between paginated and continuous scrolling. On mobile you can switch between tap-to-page and swipe-to-page; on desktop between wheel and keyboard paging.
- **Tune the experience**: the toolbar lets you change font size, switch theme, open the TOC, and launch full-text search. More actions live in the "More" overflow menu.
- **Check progress**: the right-sidebar bookshelf view always shows progress and reading stats for every book.

---

## Settings

Configure under Obsidian Settings → Epub Viewer:

| Option | Description | Default |
| --- | --- | --- |
| Default page mode | Paginated or continuous scrolling | Continuous scrolling (scrolled) |
| Default font size | Slider 12–28px | 16px |
| Reading theme | Follow Obsidian / White / Warm / Green / Sepia / Dark | Follow Obsidian |

---

## Security

The plugin hardens ebook rendering so a malicious EPUB cannot execute code inside its iframe:

- **Content sanitization**: strips `<script>`, `<iframe>`, `<object>`, `<embed>`, removes `on*` event handlers and `srcdoc`, and blocks `javascript:` / `vbscript:` / dangerous `data:` URL protocols.
- **CSP compatibility**: Obsidian blocks `blob:` / `data:` stylesheets inside iframes; the plugin inlines those stylesheets as `<style>` so layout stays correct while respecting CSP.
- **Plugin co-existence guard**: foliate custom-element registration is wrapped in a guard so it won't throw when another foliate-based plugin (e.g. weave) on the same machine also defines the same elements.

---

## Architecture

The rendering engine is [foliate-js](https://github.com/johnfactotum/foliate-js) (^1.0.1), bundled to CJS with esbuild.

```
main.ts
└─ EpubViewerPlugin (plugin assembly root)
   ├─ EpubReaderView        reader view (toolbar / TOC sidebar / progress bar / full-text search / reading time)
   ├─ EpubBookshelfView     bookshelf view (scans vault ebooks, shows progress & reading stats)
   ├─ EpubViewerSettingsTab settings tab
   └─ ReadingProgressStore  progress store (in-memory cache + debounced persistence to data.json)
       ├─ EpubThemeManager        theme registration / application / color resolution / follow Obsidian theme
       ├─ EpubChapterResolver     TOC tree flattening, spine mapping, CFI normalization
       ├─ EpubFoliateLoader       foliate engine loader, TXT special-case, secure pipeline
       ├─ EpubFoliateGuard        custom-element registration guard (prevents multi-plugin conflicts)
       ├─ EpubFoliatePatches      blob iframe / CSP patches
       └─ EpubStylesheetInliner   stylesheet inlining and content sanitization
   └─ i18n                   zh-cn / en dictionaries
```

---

## Building from source

Requirements: Node.js with npm.

```bash
npm install        # install dependencies
npm run dev        # watch mode, rebuild main.js on change
npm run build      # production build (no sourcemap)
npm run typecheck  # type check
```

The build artifact `main.js` is produced by `esbuild.config.mjs` from `main.ts`, targeting `es2020`, CJS format, with `obsidian`, `electron`, `@codemirror/*` and Node built-ins marked external.

---

## Compatibility

- Minimum Obsidian version: `1.7.2` (see `manifest.json` and `versions.json`).
- Works on both desktop and mobile (`isDesktopOnly: false`).

---

## License

[MIT](./LICENSE) © 2026 hellokunzai
