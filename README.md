# Epub Viewer

> A clean, focused EPUB reader for Obsidian. Open EPUB, MOBI, AZW3, FB2, CBZ and TXT; enjoy paginated or continuous scrolling, adjustable font size, reading themes, a table of contents, full-text search, a bookshelf with progress, and reading-time tracking — without leaving your vault.

[中文文档](./README.zh.md)

---

## Why Epub Viewer

Most reading tools only "open the file." Epub Viewer turns Obsidian into a comfortable e-book reader. It saves your reading progress and elapsed reading time inside the plugin's own `data.json`, so your books and notes stay exactly where you left them — nothing is written back into your documents.

It is built on the [foliate-js](https://github.com/johnfactotz/foliate-js) engine and keeps things simple:

- **EPUB reading** powered by the foliate-js engine
- **Bookshelf** that tracks progress and reading time across your e-books
- **Reading progress** and **reading-time tracking** persisted locally in the plugin

---

## Features

### EPUB reading (foliate-js engine)

- **Full reading experience** — pagination / scrolling, font-size control, and **6 reading themes** (Follow Obsidian, White, Warm, Eye-care Green, Parchment, Night).
- **In-page full-text search** — search the current chapter from the toolbar.
- **Reading progress** — auto-saved position, elapsed reading time, and a remaining-time estimate.
- **Broad format support** — foliate-js natively reads EPUB, MOBI, AZW3, FB2, CBZ, and TXT.

### Bookshelf

- **One panel for your library** — every e-book in the vault shown with its progress bar and reading time.
- **Resume where you left off** — open a book and it jumps back to your last position automatically.
- **Reading time & remaining estimate** — see how long you've read and how much is left.

---

## Installation

### Via BRAT (recommended)

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin.
2. BRAT → Add Plugin → enter the repository: `hellokunzai/obsidian-book-note`.
3. Enable **Epub Viewer** after installation.
4. **Important:** after an update, fully quit and restart Obsidian (a plugin reload is not enough).

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [Releases](https://github.com/hellokunzai/obsidian-book-note/releases) page.
2. Place them in `<vault>/.obsidian/plugins/epub-viewer/`.
3. Settings → Community plugins → enable **Epub Viewer**.

### Opening EPUB files

Obsidian hides unknown extensions by default. To show `.epub` in the file explorer:

- Settings → Files & Links → enable **Detect all file extensions**.

---

## Settings

Configure under **Settings → Epub Viewer**:

| Setting | Description |
|---------|-------------|
| EPUB font size | Base body font size in px (12–28). Applies when you reopen the book. |
| EPUB reading theme | One of 6 themes. |
| EPUB flow mode | Paginated (page-turn) or Scrolled (continuous). |

---

## Commands & hotkeys

| Command | Hotkey | Action |
|---------|--------|--------|
| Open EPUB bookshelf | — | Browse e-books inside the vault. |

---

## Data storage

Reading progress and reading time are stored in the plugin's own `data.json` (under `<vault>/.obsidian/plugins/epub-viewer/`). Your book files and notes are never modified — the plugin only records where you stopped reading.

---

## Technical architecture

- **EPUB engine:** [foliate-js](https://github.com/johnfactotz/foliate-js) 1.0.1 — a single engine covering multiple formats natively.
- **Rendering:** a `foliate-view` custom element embedded in an Obsidian leaf, with CSP / sandbox patches for the desktop runtime.
- **Progress layer:** reading progress and reading time persisted in the plugin `data.json` via `ReadingProgressStore`.

---

## Development

```bash
npm install
npm run dev      # development build (with sourcemap)
npm run build    # production build
```

Type-check:

```bash
npx tsc --noEmit
```

Copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/epub-viewer/` to test in a vault.

---

## License

[MIT](./LICENSE)

## Acknowledgements

- [foliate-js](https://github.com/johnfactotz/foliate-js) — EPUB rendering engine.
- [obsidian-weave-reader](https://github.com/) — foliate integration, footnote / search / canvas references.
- [ob-epub-reader](https://github.com/) — reader integration reference.
- [Axl Light](https://github.com/rezonegame/axl-light) — original project basis.
# obsidian-epub-viewer
