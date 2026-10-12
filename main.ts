/**
 * [INPUT]: 依赖 Obsidian Plugin API、阅读进度 store 与阅读器/书架/设置视图
 * [OUTPUT]: 对外提供 EpubViewerPlugin 主类，注册命令、扩展名、书架与阅读器视图、设置
 * [POS]: 插件装配根，纯 EPUB 阅读器，不修改用户原文、不污染 vault
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

import { addIcon, Plugin, TFile } from "obsidian";
import { t } from "./src/i18n";

import {
  DEFAULT_SETTINGS,
  EpubViewerSettings,
  SUPPORTED_BOOK_EXTENSIONS,
} from "./src/storage/types";
import { ProgressMap, ReadingProgressStore } from "./src/storage/readingProgress";
import { EpubViewerSettingsTab } from "./src/settings/settingsTab";
import { EpubReaderView, EPUB_READER_VIEW_TYPE } from "./src/epub/EpubReaderView";
import { EpubBookshelfView, EPUB_BOOKSHELF_VIEW_TYPE } from "./src/epub/EpubBookshelfView";

const EPUB_VIEWER_ICON = `
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect x="5" y="5" width="90" height="90" rx="20" ry="20" fill="#F5C518"/>
    <g transform="translate(50,50) rotate(-45) translate(-18,-18)"
      fill="none" stroke="#000" stroke-width="6"
      stroke-linecap="round" stroke-linejoin="round">
      <rect x="8" y="2" width="20" height="28" rx="3" fill="#000" stroke="none"/>
      <polygon points="8,30 28,30 18,42" fill="#000" stroke="none"/>
      <line x1="8" y1="10" x2="28" y2="10" stroke="#F5C518" stroke-width="3"/>
    </g>
  </svg>
`;

export default class EpubViewerPlugin extends Plugin {
  settings: EpubViewerSettings = DEFAULT_SETTINGS;
  store!: ReadingProgressStore;

  async onload(): Promise<void> {
    addIcon("epub-viewer-icon", EPUB_VIEWER_ICON);
    this.store = new ReadingProgressStore(() => this.persist());
    await this.loadSettings();
    console.info(`epub-viewer loaded v${this.manifest.version}`);

    this.registerView(
      EPUB_READER_VIEW_TYPE,
      (leaf) => new EpubReaderView(leaf, this.store, this.settings, this),
    );
    // 把 foliate 支持的所有电子书格式绑定到阅读器视图：registerView 只注册视图工厂，
    // 还需要 registerExtensions 告诉 Obsidian「.epub/.mobi/... 用本视图打开」。
    // 参考 ob-epub-reader 与 obsidian-weave-reader 的实现；用 try/catch 防止
    // 与其他插件扩展冲突时抛错导致插件加载失败。
    try {
      this.registerExtensions([...SUPPORTED_BOOK_EXTENSIONS], EPUB_READER_VIEW_TYPE);
    } catch (error) {
      console.warn("epub-viewer: 注册电子书扩展名失败（可能与其他插件冲突）", error);
    }
    this.registerView(
      EPUB_BOOKSHELF_VIEW_TYPE,
      (leaf) => new EpubBookshelfView(leaf, this.store, (file) => this.openEpubBook(file)),
    );

    this.addSettingTab(new EpubViewerSettingsTab(this));
    this.registerCommands();
  }

  onunload(): void {
    // 注意：onunload 中不要 detachLeavesOfType。Obsidian 会自动清理插件视图；
    // 手动 detach 会把用户移动过的 leaf 重置到默认位置，并在下次加载时丢失布局。
  }

  async loadSettings(): Promise<void> {
    const stored = ((await this.loadData()) ?? {}) as Partial<EpubViewerSettings> & {
      progress?: ProgressMap;
    };
    this.settings = { ...DEFAULT_SETTINGS, ...stored };
    this.store.hydrate(stored.progress);
  }

  async saveSettings(): Promise<void> {
    await this.persist();
  }

  /** 将设置与阅读进度一起持久化到插件 data.json（不污染 vault） */
  private async persist(): Promise<void> {
    await this.saveData({
      ...this.settings,
      progress: this.store.snapshot(),
    } as unknown as Record<string, unknown>);
  }

	private registerCommands(): void {
		this.addCommand({
			id: "open-epub-bookshelf",
			name: t("command.openBookshelf"),
			callback: () => this.activateBookshelf(),
		});
	}

	/** 获取当前激活的 EPUB 阅读视图（用于命令路由与实时同步设置） */
	getActiveEpubReaderView(): EpubReaderView | null {
		const leaves = this.app.workspace.getLeavesOfType(EPUB_READER_VIEW_TYPE);
		for (const leaf of leaves) {
			if (leaf.view instanceof EpubReaderView) {
				return leaf.view;
			}
		}
		return null;
	}

  async activateBookshelf(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(EPUB_BOOKSHELF_VIEW_TYPE)[0];
    if (!leaf) {
      const nextLeaf = this.app.workspace.getRightLeaf(false);
      if (!nextLeaf) {
        return;
      }
      leaf = nextLeaf;
      await leaf.setViewState({ type: EPUB_BOOKSHELF_VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (view instanceof EpubBookshelfView) {
      view.refresh();
    }
  }

  async openEpubBook(file: TFile): Promise<void> {
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(file);
    this.app.workspace.revealLeaf(leaf);
  }
}
