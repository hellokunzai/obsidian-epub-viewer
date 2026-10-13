/**
 * [INPUT]: 依赖 Obsidian FileView/WorkspaceLeaf/TFile、foliate-js view API、
 *          storage/types 的 EPUB 进度/主题类型、
 *          EpubFoliateLoader 的引擎加载与 EpubStylesheetInliner 的安全过滤、
 *          EpubThemeManager 的主题颜色解析
 * [OUTPUT]: 对外提供 EpubReaderView，将 foliate-js 渲染引擎嵌入 Obsidian leaf，
 *          承载工具栏、侧边栏（目录）、阅读区（iframe）、进度条、
 *          阅读进度持久化与阅读时间追踪
 * [POS]: epub 模块的唯一视图入口，由插件主类通过 registerView 注册
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

import { FileView, Notice, Platform, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import { t } from "../i18n";

import {
	EPUB_READING_THEMES,
	EpubFlowMode,
	EpubReadingProgress,
	EpubReadingTheme,
	EpubViewerSettings,
	SUPPORTED_BOOK_EXTENSIONS,
} from "../storage/types";
import { ReadingProgressStore } from "../storage/readingProgress";
import {
	flattenTocTree,
	normalizeCfi,
	normalizePercent,
	resolveChapterLabel,
	TocSpineEntry,
	TocTreeNode,
} from "./EpubChapterResolver";
import { inlineBlockedStylesheets, stripScriptsFromDocument } from "./EpubStylesheetInliner";
import { EpubThemeManager } from "./EpubThemeManager";
import {
	createFoliateView,
	FoliateViewHandle,
	openBookFromBuffer,
	showFoliateStart,
} from "./EpubFoliateLoader";
import type EpubViewerPlugin from "../../main";

// ---- 常量 ----

/** 注册到 Obsidian workspace 的视图类型标识 */
export const EPUB_READER_VIEW_TYPE = "epub-viewer-epub-reader";

/** 阅读时间 flush 间隔（毫秒） */
const READING_TIME_FLUSH_INTERVAL_MS = 60_000;

/**
 * 估算剩余阅读时间所需的最小累计阅读秒数。
 * 低于此值样本太少、外推误差过大，故不展示剩余时间；
 * 取 10s 而非 60s，是为了让剩余时间在打开书后尽快出现。
 */
const MIN_READING_SECONDS_FOR_ESTIMATE = 10;

/** 鼠标滚轮翻页防抖延迟（毫秒） */
const WHEEL_DEBOUNCE_MS = 400;

/** 进度保存防抖延迟（毫秒） */
const PROGRESS_SAVE_DEBOUNCE_MS = 2_000;



/** 滚动到章节边界后，需要再滑动多少距离才跨章（像素） */
const SCROLL_OVERRUN_THRESHOLD = 40;

/** 移动端滚动模式下，relocate fraction 变化超过该阈值才判定为方向（避免浮点抖动） */
const MOBILE_NAVBAR_FRACTION_THRESHOLD = 1e-4;

/** 移动端触摸：单次手势累计位移超过该像素阈值即判定方向并触发导航栏显隐（实时灵敏） */
const MOBILE_NAVBAR_TOUCH_THRESHOLD = 10;

// ---- 辅助类型 ----

/** 阅读时间追踪器状态快照 */
interface ReadingTimeSnapshot {
	readingTimeSeconds: number;
	lastFlushTimestamp: number;
}

interface FoliateTocItem {
	label?: string;
	href?: string;
	subitems?: unknown[];
}

interface FoliateRelocateDetail {
	cfi?: string;
	index?: number;
	fraction?: number;
	reason?: string;
	range?: Range;
	tocItem?: { label?: string };
	section?: { current?: number; total?: number };
}

interface FoliateLoadDetail {
	doc?: Document;
	index?: number;
}


// ---- EpubReaderView ----

/**
 * epub-viewer EPUB 阅读器核心视图。
 *
 * 继承 Obsidian FileView，将 foliate-js <foliate-view> 嵌入 leaf 容器。
 * 负责：
 * - EPUB 文件加载与安全过滤
 * - 工具栏（字号/主题/翻页模式/导航）
 * - 侧边栏（目录）
 * - 阅读进度持久化与阅读时间追踪
 * - 键盘/滚轮导航
 */
export class EpubReaderView extends FileView {
	// ---- 依赖注入 ----

	private readonly store: ReadingProgressStore;
	private readonly themeManager: EpubThemeManager;
	private readonly settings: EpubViewerSettings;
	private readonly plugin: EpubViewerPlugin;

	// ---- foliate 实例 ----

	private foliateView: FoliateViewHandle | null = null;
	private loadedSectionDocs = new WeakMap<Document, number>();
	/** 清理 iframe 内 keydown 监听（PC 端键盘翻页） */
	private documentKeyboardCleanups = new WeakMap<Document, () => void>();
	/** 最近一次 foliate load 事件的 section doc，供工具栏全文搜索使用（getContents 不可靠时的可靠来源） */
	private currentLoadedDoc: Document | null = null;
	private currentCfi = "";
	private currentSectionIndex = 0;

	// ---- 状态 ----

	private tocEntries: TocSpineEntry[] = [];
	private tocTree: TocTreeNode[] = [];
	/** 侧栏目录 DOM 是否已构建，避免每次打开都重建整棵树 */
	private sidebarBuilt = false;
	private currentChapter = "";
	private currentPercent = 0;
	private currentFlowMode: EpubFlowMode;
	private currentFontSize: number;
	private currentTheme: EpubReadingTheme;
	private themeMenuEl: HTMLElement | null = null;
	private themeTriggerEl: HTMLElement | null = null;
	private themeOutsideClickHandler: ((e: MouseEvent) => void) | null = null;
	private themeEscHandler: ((e: KeyboardEvent) => void) | null = null;
	private themeObserver: MutationObserver | null = null;
	private sidebarOpen = false;
	/** 侧栏顶部「筛选章节」搜索框输入元素（常驻，不随目录滚动） */
	private sidebarSearchInputEl: HTMLInputElement | null = null;
	/** 搜索框内的清空按钮（×） */
	private sidebarSearchClearEl: HTMLElement | null = null;
	/** 筛选防抖定时器 */
	private sidebarSearchTimer: number | null = null;
	private canvasSendBtn: HTMLElement | null = null;

	// ---- 定时器 / 追踪 ----

	private readingTimeSeconds = 0;
	private readingTimeFlushTimer: number | null = null;
	private progressSaveTimer: number | null = null;
	private wheelDebounceTimer: number | null = null;
	/** 滚动模式下跨章导航进行中标志，防止重入 */
	private scrolledNavigating = false;
	/** 最近一次跨章导航方向，冷却期内阻止反方向触发（防止来回跳） */
	private scrolledNavDirection: "next" | "prev" | null = null;
	/** 滚动到底部后，用户继续向下滑动的累积距离 */
	private scrollOverrunNext = 0;
	/** 滚动到顶部后，用户继续向上滑动的累积距离 */
	private scrollOverrunPrev = 0;

	/** PC 端翻页模式：键盘翻页 / 滚轮翻页（互斥，默认键盘） */
	private pcNavMode: "keyboard" | "wheel" = "wheel";
	/** 移动端点按翻页开关（true=点按翻页，false=滑动翻页） */
	private mobileTapEnabled = true;
	/** 移动端 readerContainer 点击翻页监听清理函数 */
	private mobileTapZoneCleanup: (() => void) | null = null;

	// 移动端底部导航栏自动隐藏交互状态（方向驱动，无计时器）
	// - 滚动模式：向上滑动（fraction 增大）隐藏，向下滑动（fraction 减小）显示
	// - 分页模式：向右翻页（nextPage）显示，向左翻页（prevPage）隐藏
	private mobileNavbarHidden = false;
	private mobileNavbarLastFraction: number | null = null;
	/** 清理移动端触摸方向监听（renderer + 各 section iframe doc） */
	private mobileNavbarTouchCleanup: (() => void) | null = null;
	/** 清理 paginator scroll/touch/wheel 事件监听 */
	private paginatorScrollCleanup: (() => void) | null = null;
	private visibilityHandler: (() => void) | null = null;
	private blurHandler: (() => void) | null = null;
	private focusHandler: (() => void) | null = null;
	private lastFlushTimestamp = 0;

	// ---- DOM 容器引用 ----

	private toolbarEl!: HTMLElement;
	private sidebarContainerEl!: HTMLElement;
	private sidebarContentEl!: HTMLElement;
	private readerContainerEl!: HTMLElement;
	private progressEl!: HTMLElement;

	// ---- 工具栏溢出菜单 ----

	private toolbarItems: HTMLElement[] = [];
	private toolbarOverflowBtn: HTMLElement | null = null;
	private toolbarOverflowEl: HTMLElement | null = null;
	private toolbarResizeObserver: ResizeObserver | null = null;
	private toolbarOverflowOutsideClickHandler: ((event: MouseEvent) => void) | null = null;

	// ================================================================
	// 构造 & 生命周期
	// ================================================================

	constructor(
		leaf: WorkspaceLeaf,
		store: ReadingProgressStore,
		settings: EpubViewerSettings,
		plugin: EpubViewerPlugin,
	) {
		super(leaf);
		this.store = store;
		this.settings = settings;
		this.plugin = plugin;
		this.themeManager = new EpubThemeManager();
		this.currentFlowMode = settings.epubDefaultFlow;
		this.currentFontSize = settings.epubFontSize;
		this.currentTheme = settings.epubReadingTheme;
	}

	/** 视图类型标识，供 Obsidian workspace 路由 */
	override getViewType(): string {
		return EPUB_READER_VIEW_TYPE;
	}

	/** leaf 标签页显示的标题 */
	override getDisplayText(): string {
		return this.file?.basename ?? "EPUB Reader";
	}

	/** 声明此视图可以打开 EPUB 及 foliate 支持的所有电子书格式 */
	override canAcceptExtension(extension: string): boolean {
		return (SUPPORTED_BOOK_EXTENSIONS as readonly string[]).includes(extension.toLowerCase());
	}

	/** 视图打开时构建 DOM 骨架 */
	override async onOpen(): Promise<void> {
		this.contentEl.addClass("epub-viewer-epub-reader");
		this.buildLayout();
		this.startReadingTimeTracker();
		this.startObsidianThemeWatcher();

		// 移动端：底部导航栏默认显示，滑动/翻页后延时隐藏、停顿后恢复。
		// 具体交互见 setupMobileNavbarAutoHide（参考 Obsidian 移动端 markdown 阅读/编辑效果）。
		this.setupMobileNavbarAutoHide();
	}

	/** 视图关闭时释放 foliate 资源与定时器 */
	override async onClose(): Promise<void> {
		this.stopReadingTimeTracker();
		this.destroyRendition();
		this.stopObsidianThemeWatcher();
		this.destroyToolbarOverflow();

		// 清理移动端点击翻页监听
		if (this.mobileTapZoneCleanup) {
			this.mobileTapZoneCleanup();
			this.mobileTapZoneCleanup = null;
		}

		// 清理移动端底部导航栏自动隐藏交互（移除监听/定时器并恢复导航栏显示）
		this.teardownMobileNavbarAutoHide();
	}

	// ================================================================
	// 移动端底部导航栏自动隐藏（参考 Obsidian 移动端 markdown 阅读/编辑交互）
	// 方向驱动、无计时器：
	// - 打开阅读视图：导航栏默认显示
	// - 滚动模式：向下滑动（手指下滑，dy>0）→ 显示；向上滑动（dy<0）→ 隐藏
	// - 分页模式：向左翻页（左滑 dx<0，nextPage）→ 隐藏；向右翻页（右滑 dx>0，prevPage）→ 显示
	// 仅使用自定义 epub-viewer-mobile-hide-nav 标记类配合 styles.css 的
	// display:none 隐藏底部导航栏（.mobile-navbar）与编辑工具栏（.mobile-toolbar）。
	// 注意：不使用 Obsidian 原生 .is-hidden-nav 状态——官方 CSS 中 is-hidden-nav
	// 会同时隐藏顶部 .view-header（标题栏），而本插件设计刻意保留顶部标题栏
	// （见 buildLayout 注释），故必须弃用该类，仅隐藏底部栏。
	// 显隐触发有两路，互为补充且都幂等于 mobileNavbarHidden 标志：
	// - 方向驱动（handleMobileNavbarScrollDirection，基于 foliate relocate 的 fraction）：覆盖键盘/程序化滚动等非触摸场景；
	// - 实时触摸（attachMobileNavbarTouchTracking，挂在 renderer + 各 section iframe doc 上）：
	//   滑动/翻页手势一开始（累计位移超 MOBILE_NAVBAR_TOUCH_THRESHOLD）即触发，无需等待 relocate 落地，灵敏度最高。
	// ================================================================

	/** 初始化移动端底部导航栏状态：默认显示，重置方向基线 */
	private setupMobileNavbarAutoHide(): void {
		if (!Platform.isMobile) return;
		this.mobileNavbarLastFraction = null;
		this.mobileNavbarShow();
	}

	/** 恢复导航栏显示并清理状态（仅移动端生效，避免残留隐藏影响其他视图/桌面端） */
	private teardownMobileNavbarAutoHide(): void {
		this.mobileNavbarLastFraction = null;
		document.body.removeClass("epub-viewer-mobile-hide-nav");
		this.mobileNavbarHidden = false;
	}

	/**
	 * 滚动模式下根据 relocate 的 fraction 变化方向控制导航栏显隐。
	 * - fraction 增大（向下阅读 / 向上滑动）→ 显示
	 * - fraction 减小（向上阅读 / 向下滑动）→ 隐藏
	 * 首次 relocate 仅建立基线，不触发；阈值过滤浮点抖动。
	 */
	private handleMobileNavbarScrollDirection(fraction: number): void {
		if (!Platform.isMobile || this.currentFlowMode !== "scrolled") return;
		if (this.mobileNavbarLastFraction === null) {
			this.mobileNavbarLastFraction = fraction;
			return;
		}
		const delta = fraction - this.mobileNavbarLastFraction;
		this.mobileNavbarLastFraction = fraction;
		if (delta > MOBILE_NAVBAR_FRACTION_THRESHOLD) {
			this.mobileNavbarShow();
		} else if (delta < -MOBILE_NAVBAR_FRACTION_THRESHOLD) {
			this.mobileNavbarHide();
		}
	}

	private mobileNavbarHide(): void {
		if (this.mobileNavbarHidden) return;
		this.mobileNavbarHidden = true;
		document.body.addClass("epub-viewer-mobile-hide-nav");
	}

	private mobileNavbarShow(): void {
		if (!this.mobileNavbarHidden) return;
		this.mobileNavbarHidden = false;
		document.body.removeClass("epub-viewer-mobile-hide-nav");
	}

	/**
	 * 移动端：在 foliate 阅读区（renderer + 每个已加载/后续加载的 section iframe doc）
	 * 上挂载实时触摸方向监听，使底部导航栏在滑动/翻页手势一开始（累计位移超
	 * MOBILE_NAVBAR_TOUCH_THRESHOLD）即触发隐藏/显示，而非等待 foliate 的 relocate
	 * 事件落地——这是此前「触发不够灵敏 / 真机无反应」的根因：relocate 在连续滑动期间
	 * 很少即时派发，且初始 section 的 iframe 在监听挂载前就可能已 load 完成，仅依赖
	 * load 事件会漏挂已加载的 iframe，导致手指在可见正文里滑动时事件收不到。
	 *
	 * 关键修复：挂载时先注册 load 监听（捕获后续动态加载的 section），再立即用
	 * collectFoliateDocs() 穿透 shadow DOM 收集「当前已存在」的 section iframe
	 * contentDocument 并挂监听，覆盖初始可见 section。两者都走统一的 attachToDoc
	 * （按 doc 去重），mobileNavbarTouchCleanup 一并移除（renderer 销毁时调用）。
	 *
	 * 方向映射（与 nextPage/prevPage、点击翻页区、原型验证一致，按用户要求整体反转）：
	 * - 滚动模式：手指下滑（dy>0）→ 显示；手指上滑（dy<0）→ 隐藏
	 * - 分页模式：左滑（dx<0，nextPage）→ 隐藏；右滑（dx>0，prevPage）→ 显示
	 *
	 * 采用相对上一帧的增量累计（accumDX/accumDY）判定方向，比「相对起点」更抗手指抖动；
	 * 单次手势只判定一次（decided 标志），避免来回切换；touchend/touchcancel 复位。
	 */
	private attachMobileNavbarTouchTracking(): void {
		if (!Platform.isMobile) return;
		if (this.mobileNavbarTouchCleanup) {
			this.mobileNavbarTouchCleanup();
			this.mobileNavbarTouchCleanup = null;
		}

		const renderer = this.foliateView?.renderer as HTMLElement | undefined;
		if (!renderer) return;

		const iframeDocs: Document[] = [];
		let lastX = 0;
		let lastY = 0;
		let accumDX = 0;
		let accumDY = 0;
		let active = false;
		let decided = false;

		const onStart = (e: TouchEvent): void => {
			if (e.touches.length !== 1) {
				active = false;
				return;
			}
			active = true;
			decided = false;
			lastX = e.touches[0].clientX;
			lastY = e.touches[0].clientY;
			accumDX = 0;
			accumDY = 0;
		};

		const onMove = (e: TouchEvent): void => {
			if (!active || decided || e.touches.length !== 1) return;
			const x = e.touches[0].clientX;
			const y = e.touches[0].clientY;
			accumDX += x - lastX;
			accumDY += y - lastY;
			lastX = x;
			lastY = y;

			if (this.currentFlowMode === "scrolled") {
				// 滚动模式：手指下滑 dy>0 → 显示；上滑 dy<0 → 隐藏（按用户要求反转）
				if (accumDY > MOBILE_NAVBAR_TOUCH_THRESHOLD) {
					decided = true;
					this.mobileNavbarShow();
				} else if (accumDY < -MOBILE_NAVBAR_TOUCH_THRESHOLD) {
					decided = true;
					this.mobileNavbarHide();
				}
			} else {
				// 分页模式：左滑 dx<0（nextPage）→ 隐藏；右滑 dx>0（prevPage）→ 显示（按用户要求反转）
				if (accumDX < -MOBILE_NAVBAR_TOUCH_THRESHOLD) {
					decided = true;
					this.mobileNavbarHide();
				} else if (accumDX > MOBILE_NAVBAR_TOUCH_THRESHOLD) {
					decided = true;
					this.mobileNavbarShow();
				}
			}
		};

		const onEnd = (): void => {
			active = false;
			decided = false;
		};

		// 统一的 doc 挂载（按 doc 去重），renderer 与每个 section iframe doc 共用同一组回调
		const attachToDoc = (doc: Document | undefined): void => {
			if (!doc || iframeDocs.includes(doc)) return;
			iframeDocs.push(doc);
			doc.addEventListener("touchstart", onStart, { passive: true });
			doc.addEventListener("touchmove", onMove, { passive: true });
			doc.addEventListener("touchend", onEnd, { passive: true });
			doc.addEventListener("touchcancel", onEnd, { passive: true });
		};

		// 1) 先挂 load 监听，捕获挂载之后动态加载的 section iframe
		const loadHandler = (e: Event): void => {
			const doc = (e as CustomEvent).detail?.doc as Document | undefined;
			attachToDoc(doc);
		};
		renderer.addEventListener("load", loadHandler);

		// 2) 立即收集当前已加载的 section iframe（含初始可见 section），
		//    避免其 load 事件在监听挂载前已触发而被漏挂——这是此前真机无反应的主因
		for (const doc of this.collectFoliateDocs()) {
			attachToDoc(doc);
		}

		// 3) renderer 自身也挂一份，覆盖手指落在非 iframe 区域（如 padding）的兜底
		renderer.addEventListener("touchstart", onStart, { passive: true });
		renderer.addEventListener("touchmove", onMove, { passive: true });
		renderer.addEventListener("touchend", onEnd, { passive: true });
		renderer.addEventListener("touchcancel", onEnd, { passive: true });

		this.mobileNavbarTouchCleanup = () => {
			renderer.removeEventListener("touchstart", onStart);
			renderer.removeEventListener("touchmove", onMove);
			renderer.removeEventListener("touchend", onEnd);
			renderer.removeEventListener("touchcancel", onEnd);
			renderer.removeEventListener("load", loadHandler);
			for (const doc of iframeDocs) {
				doc.removeEventListener("touchstart", onStart);
				doc.removeEventListener("touchmove", onMove);
				doc.removeEventListener("touchend", onEnd);
				doc.removeEventListener("touchcancel", onEnd);
			}
		};
	}

	// ================================================================
	// 文件加载（FileView 核心）
	// ================================================================

	/**
	 * Obsidian FileView 文件加载钩子。
	 * 读取 EPUB 二进制内容 → foliate-js 解析 → 渲染 → 恢复进度。
	 *
	 * @param file - 用户打开的 EPUB TFile
	 */
	override async onLoadFile(file: TFile): Promise<void> {
		this.destroyRendition();

		try {
			const arrayBuffer = await this.app.vault.readBinary(file);
			this.foliateView = await createFoliateView(this.readerContainerEl);
			this.configureFoliateView(this.foliateView);
			this.registerFoliateEvents(this.foliateView);
			await openBookFromBuffer(this.foliateView, arrayBuffer, file.name);
			this.attachPaginatorScrollListener();
			this.attachMobileNavbarTouchTracking();
			this.applyFoliateLayout();
			this.tocEntries = this.buildFoliateTocEntries(this.foliateView.book?.toc ?? []);
			this.applyFoliateAppearance();

			await this.restoreProgress();

			this.renderToolbar();
			this.sidebarBuilt = false;
			this.renderSidebar();
		} catch (error) {
			console.error("epub-viewer: EPUB load failed", error);
			new Notice(t("epub.loadFailed", { error: error instanceof Error ? error.message : String(error) }));
		}
	}

	/**
	 * Obsidian FileView 文件卸载钩子。
	 * flush 阅读时间并销毁 foliate-view。
	 *
	 * @param _file - 即将卸载的 TFile（未使用）
	 */
	override async onUnloadFile(_file: TFile): Promise<void> {
		await this.flushReadingTime();
		await this.saveCurrentProgress();
		this.destroyRendition();
	}

	// ================================================================
	// 布局构建
	// ================================================================

	/**
	 * 构建完整的 DOM 布局骨架：
	 * 工具栏 → [侧边栏 | 阅读区] → 进度条
	 *
	 * 使用 this.contentEl 而不是 this.containerEl，保留 Obsidian 原生 view-header
	 *（文件图标 / 标题 / 更多菜单），让 EPUB 工具栏位于标题栏下方，从而支持
	 * 在阅读时切换文件和访问文件选项。
	 */
	private buildLayout(): void {
		this.contentEl.empty();
		this.toolbarItems = [];
		this.toolbarOverflowBtn = null;
		this.toolbarOverflowEl = null;

		this.toolbarEl = this.contentEl.createDiv({ cls: "epub-viewer-epub-toolbar" });
		this.toolbarOverflowEl = this.toolbarEl.createDiv({ cls: "epub-viewer-epub-toolbar-overflow-menu" });

		const body = this.contentEl.createDiv({ cls: "epub-viewer-epub-body" });

		this.sidebarContainerEl = body.createDiv({ cls: "epub-viewer-epub-sidebar" });
		this.sidebarContainerEl.toggleClass("is-open", this.sidebarOpen);

		// 侧栏顶部常驻搜索框（固定不随目录滚动），必须在内容容器之前创建
		this.renderSidebarSearchBox();

		this.sidebarContentEl = this.sidebarContainerEl.createDiv({ cls: "epub-viewer-epub-sidebar-content" });

		this.readerContainerEl = body.createDiv({ cls: "epub-viewer-epub-reader-area" });
		// 脚注预览 popover 元素（Phase 4-B P3）

		this.progressEl = this.contentEl.createDiv({ cls: "epub-viewer-epub-progress" });


		this.contentEl.addEventListener("keydown", (event) => this.handleKeydown(event));
		this.readerContainerEl.addEventListener("wheel", (event) => this.handleWheel(event), { passive: false });
		this.readerContainerEl.addEventListener("click", (event) => this.handleReaderAreaClick(event));

		// 移动端：readerContainer 点击翻页（左 1/3 上一页/章，右 1/3 下一页/章）
		if (Platform.isMobile) {
			const tapHandler = (event: MouseEvent) => this.handleTapZone(event);
			this.readerContainerEl.addEventListener("click", tapHandler);
			this.mobileTapZoneCleanup = () => {
				this.readerContainerEl.removeEventListener("click", tapHandler);
			};
		}
	}

	/**
	 * 监听 Obsidian 原生主题变化（亮/暗切换、主题更换、CSS snippet 变更）。
	 *
	 * 当 Obsidian 修改 body 的 class 或 style 时，重新应用当前 EPUB 主题，确保
	 * obsidian 主题下颜色实时同步，同时让 CSS 变量驱动的外层容器/工具栏立刻生效。
	 */
	private startObsidianThemeWatcher(): void {
		this.stopObsidianThemeWatcher();

		this.themeObserver = new MutationObserver(() => {
			this.applyFoliateAppearance();
		});

		this.themeObserver.observe(document.body, {
			attributes: true,
			attributeFilter: ["class", "style"],
		});
	}

	private stopObsidianThemeWatcher(): void {
		if (this.themeObserver) {
			this.themeObserver.disconnect();
			this.themeObserver = null;
		}
	}

	// ================================================================
	// 工具栏
	// ================================================================

	/**
	 * 渲染工具栏：侧边栏切换、字号、主题、翻页模式、导航按钮。
	 *
	 * 书名已由 Obsidian 原生 view-header 显示，因此工具栏内不再重复显示书名。
	 * 工具栏固定为一行，装不下的按钮会自动移入“更多”下拉菜单。
	 */
	private renderToolbar(): void {
		// 重建前先关闭可能展开的主题下拉，解绑监听，避免泄漏
		this.closeThemeDropdown();

		// 只移除已有的按钮和色块容器，保留 overflow menu（它现在是 toolbarEl 的子元素）
		const children = Array.from(this.toolbarEl.children);
		for (const child of children) {
			if (child === this.toolbarOverflowEl) continue;
			if (child.hasClass("epub-viewer-epub-toolbar-btn") || child.hasClass("epub-viewer-epub-theme-swatches")) {
				child.remove();
			}
		}

		this.toolbarItems = [];
		if (this.toolbarOverflowEl) {
			this.toolbarOverflowEl.empty();
			this.toolbarOverflowEl.removeClass("is-open");
		}

		const createBtn = (opts: {
			icon?: string;
			text?: string;
			title: string;
			onClick: () => void;
		}): HTMLElement => {
			const btn = this.toolbarEl.createEl("button", {
				cls: "epub-viewer-epub-toolbar-btn clickable-icon",
				attr: { type: "button", "aria-label": opts.title },
			});
			if (opts.icon) setIcon(btn, opts.icon);
			if (opts.text) btn.textContent = opts.text;
			btn.addEventListener("click", opts.onClick);
			return btn;
		};

		// 导航模式按钮（PC: 键盘↔滚轮互斥切换；移动端: 点按↔滑动切换）
		const keyNavBtn = createBtn({
			icon: Platform.isMobile
				? (this.mobileTapEnabled ? "hand" : "move")
				: (this.pcNavMode === "keyboard" ? "keyboard" : "mouse"),
			title: Platform.isMobile
				? (this.mobileTapEnabled ? t("epub.toggleToSwipe") : t("epub.toggleToTap"))
				: (this.pcNavMode === "keyboard" ? t("epub.toggleToWheel") : t("epub.toggleToKeyboard")),
			onClick: () => this.toggleKeyNav(),
		});

		this.toolbarItems.push(
			createBtn({ icon: "panel-left", title: t("aria.toggleSidebar"), onClick: () => this.toggleSidebar() }),
			createBtn({ text: "A-", title: t("aria.decreaseFont"), onClick: () => this.changeFontSize(-1) }),
			createBtn({ text: "A+", title: t("aria.increaseFont"), onClick: () => this.changeFontSize(1) }),
			createBtn({ icon: "search", title: t("aria.searchFull"), onClick: () => this.toggleToolbarSearch() }),
			createBtn({
				icon: this.currentFlowMode === "paginated" ? "lines-of-text" : "scroll",
				title: this.currentFlowMode === "paginated" ? t("epub.toggleScroll") : t("epub.togglePaginate"),
				onClick: () => this.toggleFlowMode(),
			}),
			keyNavBtn,
			createBtn({ icon: "chevron-left", title: t("aria.prevPage"), onClick: () => this.prevPage() }),
			createBtn({ icon: "chevron-right", title: t("aria.nextPage"), onClick: () => this.nextPage() }),
			this.renderThemeDropdown(),
		);

		this.toolbarOverflowBtn = createBtn({
			icon: "more-vertical",
			title: t("common.more"),
			onClick: () => this.toggleToolbarOverflow(),
		});
		this.toolbarOverflowBtn.addClass("epub-viewer-epub-toolbar-overflow-btn");
		this.toolbarItems.push(this.toolbarOverflowBtn);

		// 普通项按顺序插入，溢出按钮固定在最右侧
		for (const item of this.toolbarItems) {
			if (item !== this.toolbarOverflowBtn) {
				this.toolbarEl.appendChild(item);
			}
		}
		if (this.toolbarOverflowBtn) {
			this.toolbarEl.appendChild(this.toolbarOverflowBtn);
		}

		// 确保 overflow menu 始终在最后
		if (this.toolbarOverflowEl) {
			this.toolbarEl.appendChild(this.toolbarOverflowEl);
		}

		this.setupToolbarOverflow();
		this.layoutToolbarOverflow();
	}

	/**
	 * 在工具栏中渲染主题下拉框：触发器 = 当前主题色块 + 倒三角，点击展开主题列表。
	 * 下拉菜单每行 = 色块 + 主题名 + 当前项打勾，支持点击外部 / Esc 关闭。
	 * @returns 主题下拉容器元素
	 */
	private renderThemeDropdown(): HTMLElement {
		const container = this.toolbarEl.createDiv({ cls: "epub-viewer-epub-theme-swatches" });

		const trigger = container.createEl("button", {
			cls: "epub-viewer-epub-theme-trigger epub-viewer-epub-toolbar-btn",
			attr: {
				type: "button",
				"aria-label": t("aria.themeTrigger"),
				"aria-haspopup": "true",
				"aria-expanded": "false",
			},
		});

		// 当前主题色块
		const swatch = trigger.createEl("span", { cls: "epub-viewer-epub-theme-trigger-swatch" });
		swatch.style.background = this.resolveThemeSwatch(this.currentTheme);

		// 下拉菜单
		const menu = container.createEl("div", {
			cls: "epub-viewer-epub-theme-menu",
			attr: { role: "menu" },
		});

		for (const theme of EPUB_READING_THEMES) {
			const item = menu.createEl("button", {
				cls: "epub-viewer-epub-theme-item",
				attr: {
					type: "button",
					role: "menuitemradio",
					"aria-checked": theme.id === this.currentTheme ? "true" : "false",
				},
			});
			item.toggleClass("is-active", theme.id === this.currentTheme);

			const itemSwatch = item.createEl("span", { cls: "epub-viewer-epub-theme-item-swatch" });
			itemSwatch.style.background = theme.swatch;

			item.createSpan({ text: theme.label, cls: "epub-viewer-epub-theme-item-label" });

			const check = item.createEl("span", { cls: "epub-viewer-epub-theme-item-check" });
			setIcon(check, "check");

			item.addEventListener("click", () => {
				this.closeThemeDropdown();
				this.switchTheme(theme.id);
			});
		}

		trigger.addEventListener("click", (e: MouseEvent) => {
			e.stopPropagation();
			if (!menu.hasClass("is-open")) {
				this.openThemeDropdown(menu, trigger);
			} else {
				this.closeThemeDropdown();
			}
		});

		this.themeMenuEl = menu;
		this.themeTriggerEl = trigger;

		return container;
	}

	/**
	 * 根据主题 ID 取色块背景（obsidian 为半白半黑渐变）。
	 */
	private resolveThemeSwatch(themeId: EpubReadingTheme): string {
		const theme = EPUB_READING_THEMES.find((t) => t.id === themeId);
		return theme ? theme.swatch : EPUB_READING_THEMES[0].swatch;
	}

	/**
	 * 打开主题下拉菜单（固定定位，避免被溢出菜单裁剪）。
	 */
	private openThemeDropdown(menu: HTMLElement, trigger: HTMLElement): void {
		const doc = trigger.ownerDocument;
		trigger.setAttribute("aria-expanded", "true");

		// 探针法定位：position: fixed 的包含块通常是视口，但祖先带 contain/transform
		// （如 .workspace-leaf 的 contain: strict）时包含块会变成那个祖先，
		// 直接用 getBoundingClientRect() 的视口坐标写 left/top 会整体错位。
		// 先把菜单以 is-open(显示) + is-probing(固定定位到 0,0 且不可见) 状态渲染，
		// 读一次 rect —— 该 rect 原点即「真实包含块原点」的视口坐标，
		// 用「期望视口坐标 − 探针原点」换算，两种包含块情形下都成立。
		menu.addClass("is-open");
		menu.addClass("is-probing");
		const probe = menu.getBoundingClientRect();
		menu.removeClass("is-probing");

		const rect = trigger.getBoundingClientRect();
		const menuWidth = menu.offsetWidth;
		const menuHeight = menu.offsetHeight;
		const win = doc.defaultView ?? window;

		// 期望的视口坐标：右缘对齐触发器右缘，挂在触发器下方 4px
		let wantLeft = rect.right - menuWidth;
		let wantTop = rect.bottom + 4;

		// 视口边界钳制：左右不贴出屏幕
		if (wantLeft < 8) wantLeft = 8;
		if (wantLeft + menuWidth > win.innerWidth - 8) wantLeft = win.innerWidth - 8 - menuWidth;

		// 下方放不下就翻到触发器上方；上方也放不下则贴住屏幕底部
		if (wantTop + menuHeight > win.innerHeight - 8) {
			const above = rect.top - menuHeight - 4;
			wantTop = above >= 8 ? above : Math.max(8, win.innerHeight - 8 - menuHeight);
		}

		// 视口坐标 → 包含块坐标
		menu.style.left = `${wantLeft - probe.left}px`;
		menu.style.top = `${wantTop - probe.top}px`;

		this.themeOutsideClickHandler = (e: MouseEvent) => {
			const target = e.target as Node;
			if (!menu.contains(target) && !trigger.contains(target)) {
				this.closeThemeDropdown();
			}
		};
		doc.addEventListener("click", this.themeOutsideClickHandler);

		this.themeEscHandler = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				this.closeThemeDropdown();
			}
		};
		doc.addEventListener("keydown", this.themeEscHandler);
	}

	/**
	 * 关闭主题下拉菜单并解绑临时监听，避免泄漏。
	 */
	private closeThemeDropdown(): void {
		if (this.themeMenuEl) {
			this.themeMenuEl.removeClass("is-open");
		}
		if (this.themeTriggerEl) {
			this.themeTriggerEl.setAttribute("aria-expanded", "false");
		}
		if (this.themeOutsideClickHandler) {
			const doc = this.themeMenuEl?.ownerDocument ?? document;
			doc.removeEventListener("click", this.themeOutsideClickHandler);
			this.themeOutsideClickHandler = null;
		}
		if (this.themeEscHandler) {
			const doc = this.themeMenuEl?.ownerDocument ?? document;
			doc.removeEventListener("keydown", this.themeEscHandler);
			this.themeEscHandler = null;
		}
	}

	/**
	 * 设置工具栏溢出下拉菜单的 ResizeObserver 与点击外部关闭监听。
	 */
	private setupToolbarOverflow(): void {
		this.destroyToolbarOverflow();

		this.toolbarResizeObserver = new ResizeObserver(() => {
			this.layoutToolbarOverflow();
		});
		this.toolbarResizeObserver.observe(this.toolbarEl);

		this.toolbarOverflowOutsideClickHandler = (event: MouseEvent) => {
			if (!this.toolbarOverflowEl?.hasClass("is-open")) return;
			const target = event.target as Node;
			if (!this.toolbarOverflowEl.contains(target) && !this.toolbarOverflowBtn?.contains(target)) {
				this.toolbarOverflowEl.removeClass("is-open");
			}
		};
		document.addEventListener("click", this.toolbarOverflowOutsideClickHandler);
	}

	/**
	 * 清理工具栏溢出菜单的监听器。
	 */
	private destroyToolbarOverflow(): void {
		if (this.toolbarResizeObserver) {
			this.toolbarResizeObserver.disconnect();
			this.toolbarResizeObserver = null;
		}
		if (this.toolbarOverflowOutsideClickHandler) {
			document.removeEventListener("click", this.toolbarOverflowOutsideClickHandler);
			this.toolbarOverflowOutsideClickHandler = null;
		}
	}

	/**
	 * 切换“更多”下拉菜单的显示/隐藏。
	 */
	private toggleToolbarOverflow(): void {
		if (this.toolbarOverflowEl) {
			this.toolbarOverflowEl.toggleClass("is-open", !this.toolbarOverflowEl.hasClass("is-open"));
		}
	}

	/**
	 * 根据工具栏可用宽度，把放不下的按钮移入“更多”下拉菜单。
	 */
	private layoutToolbarOverflow(): void {
		if (!this.toolbarOverflowEl || !this.toolbarOverflowBtn) return;

		const toolbarWidth = this.toolbarEl.clientWidth;
		if (toolbarWidth === 0) return;

		// 先把所有可溢出项收回工具栏
		for (const item of this.toolbarItems) {
			if (item !== this.toolbarOverflowBtn) {
				this.toolbarEl.appendChild(item);
			}
		}
		// 再把溢出按钮移到最右侧（appendChild 会移动已有元素到末尾）
		this.toolbarEl.appendChild(this.toolbarOverflowBtn);
		this.toolbarOverflowEl.empty();

		const gap = 4;
		const paddingBuffer = 4;
		const availableWidth = toolbarWidth - paddingBuffer;

		// 计算所有普通项的总宽度（不含更多按钮）
		let plainTotal = 0;
		for (let i = 0; i < this.toolbarItems.length; i++) {
			const item = this.toolbarItems[i];
			if (item === this.toolbarOverflowBtn) continue;
			plainTotal += item.offsetWidth + (i > 0 ? gap : 0);
		}

		if (plainTotal <= availableWidth) {
			// 全部装得下，隐藏更多按钮
			this.toolbarOverflowBtn.addClass("is-hidden");
			return;
		}

		this.toolbarOverflowBtn.removeClass("is-hidden");
		const moreBtnWidth = this.toolbarOverflowBtn.offsetWidth;
		let usedWidth = moreBtnWidth + gap;
		let overflowIndex = -1;

		for (let i = 0; i < this.toolbarItems.length; i++) {
			const item = this.toolbarItems[i];
			if (item === this.toolbarOverflowBtn) continue;
			const itemWidth = item.offsetWidth + (i > 0 ? gap : 0);
			if (usedWidth + itemWidth > availableWidth) {
				overflowIndex = i;
				break;
			}
			usedWidth += itemWidth;
		}

		if (overflowIndex !== -1) {
			for (let i = overflowIndex; i < this.toolbarItems.length; i++) {
				const item = this.toolbarItems[i];
				if (item === this.toolbarOverflowBtn) continue;
				this.toolbarOverflowEl.appendChild(item);
			}
		}
	}

	// ================================================================
	// 侧边栏
	// ================================================================

	/**
	 * 切换侧边栏显示/隐藏。
	 */
	private toggleSidebar(): void {
		this.sidebarOpen = !this.sidebarOpen;
		this.sidebarContainerEl.toggleClass("is-open", this.sidebarOpen);
		if (this.sidebarOpen) {
			if (!this.sidebarBuilt) {
				this.renderSidebar();
			} else {
				// 已构建过：只同步当前阅读位置高亮，避免重建整棵树
				this.updateTocCurrent();
			}
			// 打开时若存在残留的筛选词，重置为完整目录，避免状态不一致
			if (this.sidebarSearchInputEl && this.sidebarSearchInputEl.value) {
				this.clearTocFilter();
			}
		}
	}

	/**
	 * 移动端：点击阅读区域时关闭目录面板。
	 * 只在 Platform.isMobile 为 true 时生效。
	 */
	private handleReaderAreaClick(event: Event): void {
		if (!Platform.isMobile || !this.sidebarOpen) {
			return;
		}
		// 如果点击的是目录面板内部，不关闭
		if (event.target instanceof Node && this.sidebarContainerEl.contains(event.target as Node)) {
			return;
		}
		this.toggleSidebar();
	}

	/**
	 * 渲染侧边栏内容（目录）。
	 * 标注已统一到「Epub Viewer」共用面板，此处仅保留目录导航。
	 */
	private renderSidebar(): void {
		this.renderTocList();
		this.sidebarBuilt = true;
	}

	/**
	 * 轻量同步目录当前项高亮，不重建 DOM。
	 * 用于翻页或重新打开侧栏时更新阅读位置标记。
	 */
	private updateTocCurrent(): void {
		const items = this.sidebarContentEl.querySelectorAll<HTMLElement>(".epub-viewer-epub-toc-item");
		items.forEach((item) => {
			const spine = item.dataset.spine;
			const isCurrent = spine !== undefined && Number(spine) === this.currentSectionIndex;
			item.toggleClass("is-current", isCurrent);
		});
	}

	/**
	 * 渲染目录列表（树形，支持父层级折叠）。
	 * 拍平的 tocEntries 供 resolveChapterLabel 使用；此处用保留层级的 tocTree 渲染。
	 *
	 * 注意：本方法自身先清空内容容器再渲染，因此可安全地从筛选态回落调用，
	 * 不会把完整目录追加到筛选结果之后（各调用方无需再手动 empty）。
	 */
	private renderTocList(): void {
		this.sidebarContentEl.empty();
		if (this.tocEntries.length === 0) {
			this.sidebarContentEl.createDiv({ cls: "epub-viewer-epub-empty", text: t("epub.emptyToc") });
			return;
		}

		const list = this.sidebarContentEl.createDiv({ cls: "epub-viewer-epub-toc-list" });

		// 事件委托：整棵列表只挂一个监听器，避免每个条目各挂一个（大目录更流畅）
		list.addEventListener("click", (event: MouseEvent) => {
			const target = event.target as HTMLElement | null;
			const item = target?.closest(".epub-viewer-epub-toc-item") as HTMLElement | null;
			if (!item) return;
			if (item.dataset.hasChildren === "true") {
				const wrapper = item.nextElementSibling as HTMLElement | null;
				if (wrapper?.classList.contains("epub-viewer-epub-toc-children")) {
					const collapsed = !wrapper.classList.contains("collapsed");
					wrapper.classList.toggle("collapsed", collapsed);
					item.classList.toggle("is-collapsed", collapsed);
				}
			} else {
				const spine = Number(item.dataset.spine);
				if (Number.isFinite(spine)) {
					this.navigateToSpineIndex(spine);
				}
			}
		});

		for (const node of this.tocTree) {
			this.renderTocNode(node, list);
		}
	}

	/**
	 * 递归渲染单个目录节点。
	 * - 含子级的父章节：点击折叠 / 展开，不跳转。
	 * - 叶子章节：点击高亮并跳转到对应 spine。
	 */
	private renderTocNode(node: TocTreeNode, container: HTMLElement): void {
		const { entry, children } = node;
		const hasChildren = children.length > 0;

		const item = container.createEl("button", {
			cls: "epub-viewer-epub-toc-item",
			attr: { type: "button" },
		});
		item.style.setProperty("--toc-depth", String(entry.level));
		item.dataset.spine = String(entry.spineIndex);
		item.dataset.hasChildren = hasChildren ? "true" : "false";
		if (hasChildren) {
			item.addClass("has-children");
			item.createSpan({ cls: "epub-viewer-epub-toc-caret", text: "▾" });
		}
		item.createSpan({ cls: "epub-viewer-epub-toc-item-text", text: entry.label });

		// 高亮当前阅读章节
		if (entry.spineIndex === this.currentSectionIndex) {
			item.addClass("is-current");
		}

		if (hasChildren) {
			const wrapper = container.createDiv({ cls: "epub-viewer-epub-toc-children" });
			const inner = wrapper.createDiv({ cls: "epub-viewer-epub-toc-children-inner" });
			for (const child of children) {
				this.renderTocNode(child, inner);
			}
		}
	}

	// ================================================================
	// 兼容旧版书签数据（运行时入口已下线）
	// ================================================================

	/**
	 * 检查当前 CFI 是否已有书签。
	 */
	// ================================================================
	// foliate 事件注册
	// ================================================================

	/**
	 * 配置 foliate-view 的布局属性。
	 */
	private configureFoliateView(view: FoliateViewHandle): void {
		const element = view as unknown as HTMLElement;
		element.addClass("epub-viewer-epub-foliate-view");
		element.setAttribute("flow", this.currentFlowMode);
		element.setAttribute("margin", this.currentFlowMode === "paginated" ? "28px" : "0px");
		element.setAttribute("gap", "8%");
		element.setAttribute("max-inline-size", "760px");
	}

	/**
	 * 注册 foliate 事件：section load、位置变更、标注绘制、标注点击。
	 */
	private registerFoliateEvents(view: FoliateViewHandle): void {
		view.addEventListener("load", this.handleFoliateLoad as EventListener);
		view.addEventListener("relocate", this.handleFoliateRelocate as EventListener);
	}

	// ================================================================
	// 安全处理
	// ================================================================

	// （安全过滤已在 foliate load 事件中处理）


	// ================================================================
	// 位置事件 & 进度
	// ================================================================

	/**
	 * 处理 foliate relocate 事件。
	 * 更新当前章节、百分比、进度条显示，并触发进度保存。
	 *
	 * 滚动模式下的跨章翻页由 relocate 事件驱动：
	 * foliate-js 在 #container 滚动后经 250ms 防抖触发 #afterScroll('scroll')，
	 * 进而 dispatch CustomEvent('relocate', { detail: { reason, start, end, viewSize } })。
	 * 此时 renderer.start/end/viewSize 已是终值，零时序问题。
	 *
	 * 注意：不能使用 detail.fraction 做边界检测——fraction = start / viewSize，
	 * 当内容 2x viewport 时最大 fraction 仅 0.5，>= 0.98 永远不触发。
	 * 正确做法：直接读 renderer.start/end/viewSize，与 foliate 内部 #scrollPrev/#scrollNext
	 * 使用相同的边界条件（start <= 0 / viewSize - end <= 2）。
	 *
	 * @param detail - foliate relocate event detail
	 */
	private handleRelocated(detail: FoliateRelocateDetail): void {
		const cfi = normalizeCfi(detail?.cfi);
		const percent = normalizePercent(detail?.fraction ?? this.currentPercent);
		// foliate view 的 relocate detail 中，section index 嵌套在 section.current 里
		// （来自 SectionProgress.getProgress 返回的 { section: { current: index } }）
		// paginator 原始 relocate 事件有顶层 index，但 view.js #onRelocate 重新包装后丢失了
		const rawIndex = detail?.section?.current ?? detail?.index;
		const spineIndex = typeof rawIndex === "number" ? rawIndex : this.currentSectionIndex;

		this.currentCfi = cfi || this.currentCfi;
		this.currentSectionIndex = Number.isFinite(spineIndex) ? spineIndex : 0;
		this.currentChapter = detail?.tocItem?.label ?? resolveChapterLabel(this.tocEntries, this.currentSectionIndex);
		this.currentPercent = percent;

		this.updateProgressBar(percent);
		// 侧栏目录已构建时，轻量同步当前项高亮（不重建 DOM）
		if (this.sidebarBuilt) {
			this.updateTocCurrent();
		}
		this.debouncedSaveProgress(this.currentCfi, percent);
	}

	/**
	 * 更新底部进度条的填充和文本。
	 *
	 * @param percent - 当前进度百分比（0-1）
	 */
	private updateProgressBar(percent: number): void {
		this.progressEl.empty();

		const percentText = `${Math.round(percent * 100)}%`;

		this.progressEl.createDiv({
			cls: "epub-viewer-epub-progress-percent",
			text: percentText,
		});

		const bar = this.progressEl.createDiv({ cls: "epub-viewer-epub-progress-bar" });
		bar.createDiv({
			cls: "epub-viewer-epub-progress-fill",
		});
		const fill = bar.querySelector<HTMLElement>(".epub-viewer-epub-progress-fill");
		if (fill) {
			fill.style.width = `${Math.round(percent * 100)}%`;
		}
	}

	/**
	 * 获取"实时"累计阅读秒数。
	 * 在已累计值基础上，补上自上次 flush 以来尚未计入的时长（仅页面可见时），
	 * 使剩余时间估算无需等待 60s 定时 flush 即可用。
	 *
	 * @returns 当前累计阅读秒数（含未 flush 的零头）
	 */
	private getLiveReadingSeconds(): number {
		let seconds = this.readingTimeSeconds;
		if (this.lastFlushTimestamp > 0 && !document.hidden) {
			seconds += Math.max(0, (Date.now() - this.lastFlushTimestamp) / 1000);
		}
		return seconds;
	}

	/**
	 * 防抖保存阅读进度。
	 * 避免高频 relocated 事件导致过多的磁盘写入。
	 *
	 * @param cfi - 当前位置的 CFI 字符串
	 * @param percent - 当前进度百分比
	 */
	private debouncedSaveProgress(cfi: string, percent: number): void {
		if (this.progressSaveTimer !== null) {
			window.clearTimeout(this.progressSaveTimer);
		}

		this.progressSaveTimer = window.setTimeout(() => {
			this.progressSaveTimer = null;
			void this.saveCurrentProgress(cfi, percent);
		}, PROGRESS_SAVE_DEBOUNCE_MS);
	}

	/**
	 * 立即保存当前阅读进度到插件 data.json。
	 *
	 * @param cfiOverride - 可选的 CFI 覆盖值
	 * @param percentOverride - 可选的百分比覆盖值
	 */
	private async saveCurrentProgress(cfiOverride?: string, percentOverride?: number): Promise<void> {
		if (!this.file) {
			return;
		}

		const cfi = cfiOverride ?? this.currentCfi;
		const percent = percentOverride ?? this.currentPercent;

		if (!cfi && percent <= 0) {
			return;
		}

		const progress: EpubReadingProgress = {
			cfi,
			chapter: this.currentChapter,
			percent,
			lastRead: new Date().toISOString(),
			readingTimeSeconds: this.readingTimeSeconds,
			estimatedRemainingMinutes: this.estimateRemainingMinutes(),
		};

		try {
			await this.store.saveEpubProgress(this.file, progress);
		} catch (error) {
			console.error("epub-viewer: EPUB progress save failed", error);
		}
	}

	/**
	 * 估算剩余阅读分钟数。
	 *
	 * @returns 估算剩余分钟数；若数据不足则返回 undefined
	 */
	private estimateRemainingMinutes(): number | undefined {
		const readingSeconds = this.getLiveReadingSeconds();
		if (this.currentPercent <= 0.01 || readingSeconds < MIN_READING_SECONDS_FOR_ESTIMATE) {
			return undefined;
		}

		const remainingFraction = 1 - this.currentPercent;
		if (remainingFraction <= 0) {
			return 0;
		}

		const estimatedRemainingSeconds = (readingSeconds / this.currentPercent) * remainingFraction;
		return Math.round(estimatedRemainingSeconds / 60);
	}

	/**
	 * 恢复上次阅读进度并跳转。
	 */
	private async restoreProgress(): Promise<void> {
		if (!this.file || !this.foliateView) {
			return;
		}

		const progress = await this.store.getEpubProgress(this.file);
		if (!progress) {
			await showFoliateStart(this.foliateView);
			return;
		}

		this.readingTimeSeconds = progress.readingTimeSeconds ?? 0;

		const cfi = normalizeCfi(progress.cfi);
		if (cfi) {
			try {
				await this.foliateView.goTo(cfi);
				this.currentCfi = cfi;
			} catch {
				await showFoliateStart(this.foliateView);
			}
		} else {
			await showFoliateStart(this.foliateView);
		}

		this.currentPercent = normalizePercent(progress.percent);
		this.updateProgressBar(this.currentPercent);
	}

	// ================================================================
	// 渲染事件
	// ================================================================

	/**
	 * 处理 foliate section 加载后的渲染刷新。
	 * 刷新标注渲染（确保标注在章节切换后仍然可见）。
	 */
	private handleRendered(): void {
		// 纯阅读器：章节渲染后无需恢复批注
	}

	// ================================================================
	// 键盘 & 滚轮导航
	// ================================================================

	/**
	 * 处理键盘导航事件（PC 端，键盘/滚轮互斥）。
	 *
	 * pcNavMode === "keyboard" 时生效：
	 *   翻页模式：← 上一页 / → 下一页；Space 下一页 / Shift+Space 上一页；
	 *             PageUp/PageDown 同向翻页；Home 跳到书首，End 跳到书尾。
	 *   滚动模式：↑ 上一章 / ↓ 下一章；Home 跳到书首，End 跳到书尾；
	 *             其余按键交给 iframe 原生滚动。
	 *
	 * pcNavMode === "wheel" 时：preventDefault 所有导航键（含方向键/Space/
	 *   PageUp/Down/Home/End），阻止滚动模式下的原生滚动和分页模式下 foliate
	 *   自身的键盘处理，确保滚轮模式下键盘完全不干预阅读。
	 *
	 * ⚠️ 阅读正文渲染在 foliate iframe 内，iframe 的键盘事件不会冒泡到父文档，
	 *    因此除 contentEl 监听外，还需在 handleFoliateLoad 中把本方法挂到每个
	 *    section document 上（attachKeyboardNavigation），否则阅读时焦点在
	 *    iframe 内、键盘翻页不生效。
	 *
	 * ⚠️ event.target 可能来自 iframe realm，不能用 instanceof 判断标签
	 *    （跨 realm instanceof 不可靠），改用 tagName 字符串比较。
	 *
	 * @param event - 键盘事件
	 */
	private handleKeydown(event: KeyboardEvent): void {
		// 输入框/文本域/下拉框/可编辑区域内不拦截，保证正常打字与表单操作
		const target = event.target as Element | null;
		if (target && typeof target.tagName === "string") {
			const tag = target.tagName.toUpperCase();
			if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT" || (target as HTMLElement).isContentEditable) {
				return;
			}
		}

		const isPaginated = this.currentFlowMode === "paginated";

		// 滚轮翻页模式下禁用键盘导航（键盘/滚轮互斥）
		if (this.pcNavMode !== "keyboard") {
			// 阻止导航键的原生行为（滚动模式下的原生滚动、分页模式下 foliate 自身处理），
			// 确保滚轮模式下键盘完全不干预阅读
			switch (event.key) {
				case "ArrowUp":
				case "ArrowDown":
				case "ArrowLeft":
				case "ArrowRight":
				case " ":
				case "PageUp":
				case "PageDown":
				case "Home":
				case "End":
					event.preventDefault();
					break;
				default:
					break;
			}
			return;
		}

		switch (event.key) {
			case "ArrowLeft": {
				// 翻页模式：上一页；滚动模式不拦截
				if (isPaginated) {
					event.preventDefault();
					this.prevPage();
				}
				break;
			}
			case "ArrowRight": {
				// 翻页模式：下一页；滚动模式不拦截
				if (isPaginated) {
					event.preventDefault();
					this.nextPage();
				}
				break;
			}
			case "ArrowUp": {
				// 滚动模式：上一章；翻页模式不拦截
				if (!isPaginated) {
					event.preventDefault();
					this.prevPage();
				}
				break;
			}
			case "ArrowDown": {
				// 滚动模式：下一章；翻页模式不拦截
				if (!isPaginated) {
					event.preventDefault();
					this.nextPage();
				}
				break;
			}
			case " ": {
				// Space 下一页 / Shift+Space 上一页；滚动模式交给原生滚动
				if (isPaginated) {
					event.preventDefault();
					if (event.shiftKey) {
						this.prevPage();
					} else {
						this.nextPage();
					}
				}
				break;
			}
			case "PageDown": {
				if (isPaginated) {
					event.preventDefault();
					this.nextPage();
				}
				break;
			}
			case "PageUp": {
				if (isPaginated) {
					event.preventDefault();
					this.prevPage();
				}
				break;
			}
			case "Home": {
				event.preventDefault();
				this.goToBookStart();
				break;
			}
			case "End": {
				event.preventDefault();
				this.goToBookEnd();
				break;
			}
		default:
			break;
		}
	}

	/**
	 * 处理移动端点击翻页（tap zones）。
	 *
	 * 屏幕左 1/3 = 上一页/章，右 1/3 = 下一页/章，中间 1/3 不触发。
	 * 两种模式（分页/滚动）统一使用 prevPage()/nextPage()。
	 *
	 * ⚠️ iframe 内的点击事件不会冒泡到父文档，因此除 readerContainerEl 上的
	 *    监听外，还需在 attachKeyboardNavigation 中给每个 section document
	 *    单独挂 click 监听（capture 阶段，先于 foliate 自身处理器执行）。
	 *
	 * 排除情况：
	 * - mobileTapEnabled 关闭时不拦截（滑动翻页模式）
	 * - 侧边栏打开时不拦截（让 handleReaderAreaClick 先关侧边栏）
	 * - 点击链接/按钮时不拦截（保证正常跳转和交互）
	 * - 有文本选区时不拦截（防止选完文字后误触翻页）
	 *
	 * @param event - 鼠标点击事件（移动端 touchend 后合成）
	 */
	private handleTapZone(event: MouseEvent): void {
		if (!this.mobileTapEnabled) {
			return;
		}

		// 侧边栏打开时让 handleReaderAreaClick 先关闭它
		if (this.sidebarOpen) {
			return;
		}

		// 点击链接/按钮时不拦截
		const target = event.target as Element | null;
		if (target) {
			let el: Element | null = target;
			while (el) {
				const tag = el.tagName;
				if (typeof tag === "string") {
					const upper = tag.toUpperCase();
					if (upper === "A" || upper === "BUTTON") {
						return;
					}
				}
				el = el.parentElement;
			}
		}

		// 有文本选区时不拦截（防止选完文字后误触翻页）
		const doc = target?.ownerDocument ?? document;
		const selection = doc.getSelection?.();
		if (selection && !selection.isCollapsed) {
			return;
		}

		// 计算点击位置占屏幕宽度的比例
		let ratio: number;
		if (event.currentTarget === this.readerContainerEl) {
			const rect = this.readerContainerEl.getBoundingClientRect();
			ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0.5;
		} else {
			// iframe document 上下文：clientX 相对于 iframe 视口
			const view = (event.view ?? window) as Window;
			ratio = view.innerWidth > 0 ? event.clientX / view.innerWidth : 0.5;
		}

		if (ratio < 0.33) {
			event.preventDefault();
			event.stopPropagation();
			this.prevPage();
		} else if (ratio > 0.67) {
			event.preventDefault();
			event.stopPropagation();
			this.nextPage();
		}
		// 中间 1/3 不触发，交给 foliate 原生处理
	}

	/**
	 * 处理鼠标滚轮事件（PC 端，键盘/滚轮互斥）。
	 *
	 * pcNavMode === "wheel" 时生效：
	 *   分页模式：滚轮直接翻页，带防抖保护。
	 *   滚动模式：不拦截，交给 foliate 内部 #container 自然滚动；
	 *     跨章翻页由 relocate 事件驱动（handleRelocated 中检测边界）。
	 *
	 * pcNavMode === "keyboard" 时：preventDefault 阻止滚轮在两种模式下的
	 *   原生行为（分页模式无滚动，滚动模式阻止原生滚动），确保键盘模式下
	 *   滚轮完全不干预阅读。
	 *
	 * @param event - 滚轮事件
	 */
	private handleWheel(event: WheelEvent): void {
		// 键盘翻页模式下禁用滚轮（键盘/滚轮互斥）
		if (this.pcNavMode !== "wheel") {
			event.preventDefault();
			return;
		}
		// 滚动模式：交给 foliate 内部自然滚动
		if (this.currentFlowMode !== "paginated") {
			return;
		}
		event.preventDefault();

		if (this.wheelDebounceTimer !== null) {
			return;
		}

		this.wheelDebounceTimer = window.setTimeout(() => {
			this.wheelDebounceTimer = null;
		}, WHEEL_DEBOUNCE_MS);

		if (event.deltaY > 0) {
			this.nextPage();
		} else if (event.deltaY < 0) {
			this.prevPage();
		}
	}

	/**
	 * 翻到下一页。
	 */
	private nextPage(): void {
		if (!this.foliateView) {
			return;
		}
		// 分页模式向右翻页 → 隐藏底部导航栏（按用户要求反转显示逻辑）
		this.mobileNavbarHide();
		const action = this.foliateView.next ?? this.foliateView.goRight;
		void action?.call(this.foliateView);
	}

	/**
	 * 翻到上一页。
	 */
	private prevPage(): void {
		if (!this.foliateView) {
			return;
		}
		// 分页模式向左翻页 → 显示底部导航栏（按用户要求反转显示逻辑）
		this.mobileNavbarShow();
		const action = this.foliateView.prev ?? this.foliateView.goLeft;
		void action?.call(this.foliateView);
	}

	/**
	 * 跳转到书籍开头（Home 键）。
	 * 优先使用 foliate 的 goToFraction(0)；不支持时回退到 goTo(0)（首个 spine）。
	 */
	private goToBookStart(): void {
		if (!this.foliateView) {
			return;
		}
		if (typeof this.foliateView.goToFraction === "function") {
			void this.foliateView.goToFraction(0);
		} else {
			void this.foliateView.goTo(0);
		}
	}

	/**
	 * 跳转到书籍结尾（End 键）。
	 * 依赖 foliate 的 goToFraction(1)；不支持时静默放弃（避免误跳到某个 spine）。
	 */
	private goToBookEnd(): void {
		if (!this.foliateView) {
			return;
		}
		if (typeof this.foliateView.goToFraction === "function") {
			void this.foliateView.goToFraction(1);
		}
	}

	/**
	 * 监听 paginator 的 scroll/touchmove/wheel 事件，在滚动模式下驱动跨章翻页。
	 *
	 * 交互语义：滚动到章节边界后，不会立即跨章；用户需要在边界处再滑动一段距离，
	 * 累积超过阈值后才触发 next/prev。这样可以避免正常滚到边界时意外跳章。
	 *
	 * 三路信号：
	 * - scroll：仅用于在离开边界时清零 overrun，本身不触发跨章。
	 * - wheel：桌面端滚轮，在边界处累积 deltaY，超过阈值后跨章。
	 * - touchmove：触摸滑动，在边界处累积手指位移，超过阈值后跨章。
	 *
	 * foliate #scrollPrev 在 start > 0 时只章内滚动到 0，需第二次 prev() 才跨章。
	 * handler 中用 async 两步调用处理此逻辑。
	 *
	 * 方向冷却：跨章后 300ms 内阻止反方向触发，防止新章节边界事件导致来回跳。
	 */
	private attachPaginatorScrollListener(): void {
		if (!this.foliateView?.renderer) return;

		// 清理旧监听并复位 overrun 状态
		if (this.paginatorScrollCleanup) {
			this.paginatorScrollCleanup();
			this.paginatorScrollCleanup = null;
		}
		this.scrollOverrunNext = 0;
		this.scrollOverrunPrev = 0;

		const renderer = this.foliateView.renderer as unknown as HTMLElement;

		/** foliate renderer 在滚动模式下暴露的边界属性 */
		interface FoliateRendererBounds {
			start: number;
			end: number;
			viewSize: number;
		}

		/** 读取当前边界状态 */
		const getBounds = (): { atBottom: boolean; atTop: boolean; maxIndex: number } | null => {
			const r = this.foliateView?.renderer as unknown as FoliateRendererBounds | undefined;
			if (!r || typeof r.start !== "number" || typeof r.end !== "number" || typeof r.viewSize !== "number")
				return null;
			return {
				atBottom: r.viewSize - r.end <= 2,
				atTop: r.start <= 2,
				maxIndex: Array.isArray(this.foliateView?.book?.sections)
					? (this.foliateView!.book!.sections!.length - 1)
					: 0,
			};
		};

		/** 执行跨章导航（next 或 prev），含两步调用和方向冷却 */
		const navigate = (direction: "next" | "prev") => {
			if (this.scrolledNavigating) return;
			if (this.currentFlowMode !== "scrolled") return;

			const bounds = getBounds();
			if (!bounds) return;

			const view = this.foliateView;
			if (!view) return;

			// 方向冷却：刚从反方向翻过来时，忽略此方向
			if (direction === "next") {
				if (!bounds.atBottom || this.currentSectionIndex >= bounds.maxIndex) return;
				if (this.scrolledNavDirection === "prev") return;
			} else {
				if (!bounds.atTop || this.currentSectionIndex <= 0) return;
				if (this.scrolledNavDirection === "next") return;
			}

			const fn = direction === "next"
				? (view.next ?? view.goRight)
				: (view.prev ?? view.goLeft);
			if (typeof fn !== "function") return;

			this.scrolledNavigating = true;
			this.scrolledNavDirection = direction;
			this.scrollOverrunNext = 0;
			this.scrollOverrunPrev = 0;

			void (async () => {
				const sectionBefore = this.currentSectionIndex;
				await fn.call(view);
				// 如果第一次没跨章（只是章内滚动到边界），再调一次跨章
				if (this.currentSectionIndex === sectionBefore) {
					await fn.call(view);
				}
				// 跨章完成后设冷却，防止新章节边界事件触发反方向
				window.setTimeout(() => {
					this.scrolledNavigating = false;
					this.scrolledNavDirection = null;
				}, 300);
			})();
		};

		/** 离开边界时清零 overrun */
		const resetOverrunIfLeftBoundary = (bounds: { atBottom: boolean; atTop: boolean } | null) => {
			if (!bounds) return;
			if (!bounds.atBottom) this.scrollOverrunNext = 0;
			if (!bounds.atTop) this.scrollOverrunPrev = 0;
		};

		// 1. scroll 事件：scrollTop 变化时触发，仅用于在离开边界时复位 overrun
		const scrollHandler = () => {
			if (this.currentFlowMode !== "scrolled") return;
			if (this.scrolledNavigating) return;
			resetOverrunIfLeftBoundary(getBounds());
		};

		// 2. wheel 事件：桌面端滚轮，在边界处累积 deltaY，超过阈值后跨章
		const wheelHandler = (e: WheelEvent) => {
			if (this.currentFlowMode !== "scrolled") return;
			if (this.scrolledNavigating) return;
			const bounds = getBounds();
			if (!bounds || (!bounds.atBottom && !bounds.atTop)) {
				this.scrollOverrunNext = 0;
				this.scrollOverrunPrev = 0;
				return;
			}

			if (bounds.atBottom && e.deltaY > 0) {
				this.scrollOverrunNext += e.deltaY;
				if (this.scrollOverrunNext >= SCROLL_OVERRUN_THRESHOLD) {
					navigate("next");
				}
			} else if (bounds.atTop && e.deltaY < 0) {
				this.scrollOverrunPrev += Math.abs(e.deltaY);
				if (this.scrollOverrunPrev >= SCROLL_OVERRUN_THRESHOLD) {
					navigate("prev");
				}
			} else {
				resetOverrunIfLeftBoundary(bounds);
			}
		};

		// 3. touchmove 事件：触摸滑动，在边界处累积手指位移，超过阈值后跨章
		let touchStartY = 0;
		let lastTouchY = 0;
		let touchActive = false;

		const touchStartHandler = (e: TouchEvent) => {
			if (e.touches.length !== 1) {
				touchActive = false;
				return;
			}
			touchStartY = e.touches[0].clientY;
			lastTouchY = touchStartY;
			touchActive = true;
		};
		const touchMoveHandler = (e: TouchEvent) => {
			if (!touchActive || e.touches.length !== 1) return;
			if (this.currentFlowMode !== "scrolled") return;
			if (this.scrolledNavigating) return;
			const bounds = getBounds();
			if (!bounds || (!bounds.atBottom && !bounds.atTop)) {
				this.scrollOverrunNext = 0;
				this.scrollOverrunPrev = 0;
				return;
			}

			const currentY = e.touches[0].clientY;
			const delta = lastTouchY - currentY; // 正=手指上移=向下滚动=下一章
			lastTouchY = currentY;

			if (bounds.atBottom && delta > 0) {
				this.scrollOverrunNext += delta;
				if (this.scrollOverrunNext >= SCROLL_OVERRUN_THRESHOLD) {
					touchActive = false;
					navigate("next");
				}
			} else if (bounds.atTop && delta < 0) {
				this.scrollOverrunPrev += Math.abs(delta);
				if (this.scrollOverrunPrev >= SCROLL_OVERRUN_THRESHOLD) {
					touchActive = false;
					navigate("prev");
				}
			} else {
				resetOverrunIfLeftBoundary(bounds);
			}
		};

		// 注册 renderer 上的监听
		renderer.addEventListener("scroll", scrollHandler);
		renderer.addEventListener("wheel", wheelHandler, { passive: true });
		renderer.addEventListener("touchstart", touchStartHandler, { passive: true });
		renderer.addEventListener("touchmove", touchMoveHandler, { passive: true });

		// iframe 内的 touch/wheel 事件不会冒泡到父文档，需通过 load 事件拿到 doc 后单独监听
		const iframeDocs: Document[] = [];
		const loadHandler = (e: Event) => {
			const doc = (e as CustomEvent).detail?.doc as Document | undefined;
			if (!doc || iframeDocs.includes(doc)) return;
			iframeDocs.push(doc);
			doc.addEventListener("touchstart", touchStartHandler, { passive: true });
			doc.addEventListener("touchmove", touchMoveHandler, { passive: true });
			doc.addEventListener("wheel", wheelHandler, { passive: true });
		};
		renderer.addEventListener("load", loadHandler);

		this.paginatorScrollCleanup = () => {
			renderer.removeEventListener("scroll", scrollHandler);
			renderer.removeEventListener("wheel", wheelHandler);
			renderer.removeEventListener("touchstart", touchStartHandler);
			renderer.removeEventListener("touchmove", touchMoveHandler);
			renderer.removeEventListener("load", loadHandler);
			for (const doc of iframeDocs) {
				doc.removeEventListener("touchstart", touchStartHandler);
				doc.removeEventListener("touchmove", touchMoveHandler);
				doc.removeEventListener("wheel", wheelHandler);
			}
		};
	}

	// ================================================================
	// 导航
	// ================================================================

	/**
	 * 导航到指定的 spine index 位置。
	 *
	 * @param spineIndex - 目标章节的 spine 索引
	 */
	private navigateToSpineIndex(spineIndex: number): void {
		if (!this.foliateView) {
			return;
		}
		void this.foliateView.goTo(spineIndex);
	}


	// ================================================================
	// 字号 & 主题
	// ================================================================

	/**
	 * 调整阅读字号。
	 *
	 * @param delta - 字号变化量（正数增大，负数缩小）
	 */
	private changeFontSize(delta: number): void {
		const nextSize = Math.max(12, Math.min(28, this.currentFontSize + delta));
		if (nextSize === this.currentFontSize) {
			return;
		}

		this.currentFontSize = nextSize;
		this.applyFontSize(nextSize);
		this.renderToolbar();
	}

	/**
	 * 将字号应用到 foliate 主题样式。
	 *
	 * @param size - 字号像素值
	 */
	private applyFontSize(size: number): void {
		this.applyFoliateAppearance(size);
	}

	/**
	 * 切换阅读主题。
	 *
	 * @param themeId - 目标主题 ID
	 */
	private switchTheme(themeId: EpubReadingTheme): void {
		if (themeId === this.currentTheme) {
			return;
		}

		this.currentTheme = themeId;

		this.applyFoliateAppearance();

		this.renderToolbar();
	}

	/**
	 * 切换翻页模式（分页/滚动）。
	 */
	private toggleFlowMode(): void {
		const nextMode: EpubFlowMode = this.currentFlowMode === "paginated" ? "scrolled" : "paginated";
		this.currentFlowMode = nextMode;

		if (!this.foliateView) {
			return;
		}

		const element = this.foliateView as unknown as HTMLElement;
		element.setAttribute("flow", nextMode);
		this.applyFoliateLayout();
		this.applyFoliateAppearance();
		this.renderToolbar();
	}

	/**
	 * 切换导航模式。
	 * PC 端在键盘翻页 / 滚轮翻页之间互斥切换。
	 * 移动端在点按翻页 / 滑动翻页之间切换。
	 */
	private toggleKeyNav(): void {
		if (Platform.isMobile) {
			this.mobileTapEnabled = !this.mobileTapEnabled;
			this.renderToolbar();
			new Notice(this.mobileTapEnabled ? t("epub.tapPageOn") : t("epub.swipePageOn"));
		} else {
			this.pcNavMode = this.pcNavMode === "keyboard" ? "wheel" : "keyboard";
			this.renderToolbar();
			new Notice(this.pcNavMode === "keyboard" ? t("epub.keyboardPageOn") : t("epub.scrollPageOn"));
		}
	}

	// ================================================================
	// ================================================================

	/**
	 * 启动阅读时间追踪。
	 * 注册 visibilitychange/blur/focus 事件监听，启动定期 flush 定时器。
	 */
	private startReadingTimeTracker(): void {
		this.lastFlushTimestamp = Date.now();

		this.readingTimeFlushTimer = window.setInterval(() => {
			void this.flushReadingTime();
		}, READING_TIME_FLUSH_INTERVAL_MS);

		this.visibilityHandler = () => {
			if (document.hidden) {
				void this.flushReadingTime();
			} else {
				this.lastFlushTimestamp = Date.now();
			}
		};
		this.blurHandler = () => {
			void this.flushReadingTime();
		};
		this.focusHandler = () => {
			this.lastFlushTimestamp = Date.now();
		};

		document.addEventListener("visibilitychange", this.visibilityHandler);
		window.addEventListener("blur", this.blurHandler);
		window.addEventListener("focus", this.focusHandler);
	}

	/**
	 * 停止阅读时间追踪。
	 * 执行最后一次 flush，移除所有事件监听和定时器。
	 */
	private stopReadingTimeTracker(): void {
		if (this.readingTimeFlushTimer !== null) {
			window.clearInterval(this.readingTimeFlushTimer);
			this.readingTimeFlushTimer = null;
		}

		if (this.visibilityHandler) {
			document.removeEventListener("visibilitychange", this.visibilityHandler);
			this.visibilityHandler = null;
		}

		if (this.blurHandler) {
			window.removeEventListener("blur", this.blurHandler);
			this.blurHandler = null;
		}

		if (this.focusHandler) {
			window.removeEventListener("focus", this.focusHandler);
			this.focusHandler = null;
		}
	}

	/**
	 * Flush 阅读时间。
	 * 计算自上次 flush 以来的经过时间（仅在页面可见时累计），
	 * 累加到 readingTimeSeconds。
	 */
	private async flushReadingTime(): Promise<void> {
		const now = Date.now();
		const elapsed = Math.round((now - this.lastFlushTimestamp) / 1000);
		this.lastFlushTimestamp = now;

		if (elapsed > 0 && !document.hidden) {
			this.readingTimeSeconds += elapsed;
		}
	}

	/**
	 * 获取当前阅读时间快照。
	 *
	 * @returns 包含累计秒数和上次 flush 时间戳的快照
	 */
	private getReadingTimeSnapshot(): ReadingTimeSnapshot {
		return {
			readingTimeSeconds: this.readingTimeSeconds,
			lastFlushTimestamp: this.lastFlushTimestamp,
		};
	}

	// ================================================================
	// 外部跳转
	// ================================================================

	/**
	 * 导航到指定 CFI 位置。
	 * 公开方法，供外部（如未来扩展或调试）跳回 EPUB 正文对应位置。
	 *
	 * @param cfiRange - CFI 范围字符串
	 */
	navigateToCfi(cfiRange: string): void {
		if (!this.foliateView) {
			return;
		}
		try {
			void this.foliateView.goTo(cfiRange);
		} catch (error) {
			console.warn("epub-viewer: navigateToCfi failed", error);
		}
	}


	// ================================================================
	// 侧栏目录筛选（即时过滤章节名）
	// ================================================================

	/**
	 * 在侧栏顶部常驻区渲染「筛选章节」搜索框。
	 * 该元素创建于 sidebarContentEl 之前，作为 flex 列布局的固定头部，
	 * 不随目录滚动（目录再长也随时可用）。
	 */
	private renderSidebarSearchBox(): void {
		const header = this.sidebarContainerEl.createDiv({ cls: "epub-viewer-epub-sidebar-search" });
		const wrap = header.createDiv({ cls: "epub-viewer-epub-sidebar-search-wrap" });

		this.sidebarSearchInputEl = wrap.createEl("input", {
			cls: "epub-viewer-epub-sidebar-search-input",
			attr: {
				type: "text",
				placeholder: t("aria.searchPlaceholder"),
				"aria-label": t("aria.filterToc"),
			},
		}) as HTMLInputElement;

		this.sidebarSearchClearEl = wrap.createEl("button", {
			cls: "epub-viewer-epub-sidebar-search-clear",
			attr: {
				type: "button",
				"aria-label": t("aria.clearSearch"),
				title: t("aria.clearSearch"),
			},
			text: "×",
		});
		this.setSidebarSearchClearVisible(false);

		// 输入时拦截按键冒泡，避免触发阅读区/全局快捷键；Esc 清空筛选
		this.sidebarSearchInputEl.addEventListener("keydown", (ev: KeyboardEvent) => {
			ev.stopPropagation();
			if (ev.key === "Escape") {
				this.clearTocFilter();
			}
		}, { capture: true });

		this.sidebarSearchInputEl.addEventListener("input", () => this.sidebarSearchDebounce(), { passive: true });
		this.sidebarSearchClearEl.addEventListener("click", () => {
			this.clearTocFilter();
			this.sidebarSearchInputEl?.focus();
		});
	}

	/** 输入防抖：120ms 后执行筛选，避免大目录逐字重渲染 */
	private sidebarSearchDebounce(): void {
		if (this.sidebarSearchTimer !== null) {
			window.clearTimeout(this.sidebarSearchTimer);
		}
		this.sidebarSearchTimer = window.setTimeout(() => {
			this.sidebarSearchTimer = null;
			this.applyTocFilter();
		}, 120);
	}

	/** 控制清空按钮显隐（仅在输入框有内容时显示） */
	private setSidebarSearchClearVisible(visible: boolean): void {
		this.sidebarSearchClearEl?.toggleClass("is-visible", visible);
	}

	/**
	 * 根据搜索框内容过滤目录。
	 * 空查询 → 回落到树形目录；非空 → 展平命中项渲染平铺列表。
	 */
	private applyTocFilter(): void {
		if (!this.sidebarSearchInputEl) return;
		const raw = this.sidebarSearchInputEl.value;
		const query = raw.trim().toLowerCase();
		this.setSidebarSearchClearVisible(raw.length > 0);

		if (query.length === 0) {
			this.renderTocList();
			return;
		}

		const matches: TocSpineEntry[] = [];
		const walk = (nodes: TocTreeNode[]): void => {
			for (const n of nodes) {
				if (n.entry.label.toLowerCase().includes(query)) {
					matches.push(n.entry);
				}
				if (n.children.length > 0) walk(n.children);
			}
		};
		walk(this.tocTree);

		this.renderTocFilterResults(matches, query);
	}

	/**
	 * 渲染筛选结果列表（平铺、带层级缩进与命中高亮）。
	 * 点击结果跳转对应章节，并自动清空筛选、恢复完整目录。
	 */
	private renderTocFilterResults(matches: TocSpineEntry[], query: string): void {
		this.sidebarContentEl.empty();

		if (matches.length === 0) {
			this.sidebarContentEl.createDiv({ cls: "epub-viewer-epub-empty", text: t("epub.tocNoMatch") });
			return;
		}

		const list = this.sidebarContentEl.createDiv({ cls: "epub-viewer-epub-toc-list" });
		const frag = document.createDocumentFragment();
		for (const entry of matches) {
			const item = document.createElement("button");
			item.className = "epub-viewer-epub-toc-item";
			item.type = "button";
			item.style.setProperty("--toc-depth", String(entry.level));
			item.dataset.spine = String(entry.spineIndex);
			item.dataset.hasChildren = "false";
			if (entry.spineIndex === this.currentSectionIndex) {
				item.classList.add("is-current");
			}

			const textSpan = document.createElement("span");
			textSpan.className = "epub-viewer-epub-toc-item-text";
			const lower = entry.label.toLowerCase();
			const idx = lower.indexOf(query);
			if (idx >= 0) {
				if (idx > 0) textSpan.append(document.createTextNode(entry.label.slice(0, idx)));
				const hit = document.createElement("span");
				hit.className = "epub-viewer-epub-toc-hit";
				hit.textContent = entry.label.slice(idx, idx + query.length);
				textSpan.appendChild(hit);
				if (idx + query.length < entry.label.length) {
					textSpan.append(document.createTextNode(entry.label.slice(idx + query.length)));
				}
			} else {
				textSpan.textContent = entry.label;
			}
			item.appendChild(textSpan);

			item.addEventListener("click", () => {
				this.navigateToSpineIndex(entry.spineIndex);
				this.clearTocFilter();
			});
			frag.appendChild(item);
		}
		list.appendChild(frag);
	}

	/** 清空筛选：重置输入框、隐藏清空按钮、恢复完整目录树 */
	private clearTocFilter(): void {
		if (this.sidebarSearchInputEl) {
			this.sidebarSearchInputEl.value = "";
		}
		this.setSidebarSearchClearVisible(false);
		if (this.sidebarBuilt) {
			this.renderTocList();
		}
	}

	// ================================================================
	// 脚注预览 & 段落模式（Phase 4-B P3，均未实现）
	// ================================================================

	// ================================================================
	// 资源清理
	// ================================================================

	/**
	 * 销毁 foliate-view 实例，释放资源。
	 */
	private destroyRendition(): void {
		if (this.progressSaveTimer !== null) {
			window.clearTimeout(this.progressSaveTimer);
			this.progressSaveTimer = null;
		}

		if (this.wheelDebounceTimer !== null) {
			window.clearTimeout(this.wheelDebounceTimer);
			this.wheelDebounceTimer = null;
		}

		if (this.foliateView) {
			try {
				this.foliateView.removeEventListener("load", this.handleFoliateLoad as EventListener);
				this.foliateView.removeEventListener("relocate", this.handleFoliateRelocate as EventListener);
				this.foliateView.close?.();
			} catch {
				/* foliate-view 可能已经销毁 */
			}
			this.foliateView = null;
		}

		if (this.paginatorScrollCleanup) {
			this.paginatorScrollCleanup();
			this.paginatorScrollCleanup = null;
		}

		if (this.mobileNavbarTouchCleanup) {
			this.mobileNavbarTouchCleanup();
			this.mobileNavbarTouchCleanup = null;
		}

		this.scrolledNavigating = false;
		this.scrolledNavDirection = null;

		if (this.readerContainerEl) {
			this.readerContainerEl.empty();
		}
	}

	/**
	 * 构建目录：先生成保留层级的 tocTree（供折叠渲染），
	 * 再拍平为按 spineIndex 升序的 tocEntries（供章节名解析 / 跳转）。
	 */
	private buildFoliateTocEntries(tocItems: FoliateTocItem[]): TocSpineEntry[] {
		this.tocTree = this.buildFoliateTocTree(tocItems);
		return flattenTocTree(this.tocTree).sort((a, b) => a.spineIndex - b.spineIndex);
	}

	/** 深度优先构建目录树，保留父子层级与 depth(level)。 */
	private buildFoliateTocTree(tocItems: FoliateTocItem[]): TocTreeNode[] {
		const walk = (items: FoliateTocItem[], level: number): TocTreeNode[] => {
			const result: TocTreeNode[] = [];
			for (const item of items) {
				const validChildren = (item.subitems ?? []).filter(
					(child): child is FoliateTocItem => typeof child === "object" && child !== null,
				);
				const children = validChildren.length ? walk(validChildren, level + 1) : [];
				const index = this.resolveFoliateHrefIndex(item.href);
				if (index !== null) {
					result.push({
						entry: { label: (item.label ?? "").trim() || t("common.chapterLabel", { index: index + 1 }), spineIndex: index, level },
						children,
					});
				} else if (children.length > 0) {
					// 父项无对应 spine（如分卷标题）时，将子项提升一层，避免层级断裂
					result.push(...children);
				}
			}
			return result;
		};
		return walk(tocItems, 0);
	}

	private resolveFoliateHrefIndex(href: string | undefined): number | null {
		if (!href || !this.foliateView?.book?.sections) {
			return null;
		}
		const normalizedHref = href.split("#")[0];
		const index = this.foliateView.book.sections.findIndex((section) => {
			const id = String(section.id ?? "");
			return id === href || id === normalizedHref || id.endsWith(normalizedHref);
		});
		return index >= 0 ? index : null;
	}

	private handleFoliateLoad = (event: Event): void => {
		const detail = (event as CustomEvent<FoliateLoadDetail>).detail;
		const doc = detail?.doc;
		if (!doc) {
			return;
		}
		const index = typeof detail.index === "number" ? detail.index : this.currentSectionIndex;
		this.loadedSectionDocs.set(doc, index);
		this.currentLoadedDoc = doc;
		stripScriptsFromDocument(doc);
		void inlineBlockedStylesheets({ document: doc });
		this.attachKeyboardNavigation(doc);
		this.handleRendered();

		// 自动聚焦 iframe，使键盘/滚轮翻页无需先手动点击
		// foliate 每次加载新 section 都会创建/复用 iframe，默认不自动获取焦点
		requestAnimationFrame(() => this.focusActiveIframe());

		// 移动端：点击 iframe 内阅读区域关闭目录面板
		if (Platform.isMobile) {
			doc.addEventListener("click", (e) => this.handleReaderAreaClick(e));
		}

		// 新 section 加载后重置滚动方向基线，避免跨章 fraction 跳变误判
		if (Platform.isMobile) {
			this.mobileNavbarLastFraction = null;
		}

	};

	private handleFoliateRelocate = (event: Event): void => {
		const detail = (event as CustomEvent<FoliateRelocateDetail>).detail ?? {};
		this.handleRelocated(detail);

		// 移动端滚动模式：依据 fraction 变化方向控制底部导航栏显隐
		if (Platform.isMobile && typeof detail.fraction === "number") {
			this.handleMobileNavbarScrollDirection(detail.fraction);
		}

		// 翻页模式下，翻页后重新聚焦 iframe。
		// foliate next/prev 在 paginated 模式下可能导致 iframe 焦点丢失，
		// 而 load 事件只在跨 section 时触发，同一章节内翻页不会重新聚焦。
		// relocate 在每次翻页后都会触发，这里补上焦点恢复。
		if (!Platform.isMobile && this.currentFlowMode === "paginated") {
			requestAnimationFrame(() => this.focusActiveIframe());
		}
	};

	/**
	 * 聚焦当前活动的 foliate iframe，使键盘/滚轮导航无需先手动点击。
	 *
	 * 翻页模式（paginated）下 foliate next/prev 可能导致 iframe 焦点丢失，
	 * 在 load 和 relocate 事件后调用此方法恢复焦点。
	 * 不抢输入框（搜索框等）焦点，仅在安全时聚焦。
	 */
	private focusActiveIframe(): void {
		// 不抢输入框焦点
		const active = document.activeElement;
		if (active) {
			const tag = active.tagName;
			if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (active as HTMLElement).isContentEditable) {
				return;
			}
		}

		const doc = this.currentLoadedDoc;
		if (!doc) return;
		const win = doc.defaultView;
		const frame = win?.frameElement;
		if (frame instanceof HTMLIFrameElement) {
			frame.focus();
		}
	}



	/**
	 * 为 foliate section iframe 挂载导航监听。
	 *
	 * - PC 端：挂 keydown，使阅读时（焦点在 iframe 内）键盘翻页生效。
	 *   iframe 的键盘事件不会冒泡到父文档，contentEl 上的监听在阅读时
	 *   收不到事件，故需逐 section document 单独挂载。
	 * - 移动端：挂 click（capture 阶段），使点击翻页区在 iframe 内生效。
	 *   capture 阶段先于 foliate 自身的 click 处理器执行，配合
	 *   stopPropagation 避免双重翻页。
	 *
	 * 幂等：同一 doc 只挂一次，cleanup 存入 WeakMap（iframe 销毁时随 GC 回收）。
	 */
	private attachKeyboardNavigation(doc: Document): void {
		if (this.documentKeyboardCleanups.has(doc)) {
			return;
		}

		const cleanups: (() => void)[] = [];

	// PC 端：键盘翻页
	const keyHandler = (event: KeyboardEvent) => this.handleKeydown(event);
	doc.addEventListener("keydown", keyHandler);
	cleanups.push(() => doc.removeEventListener("keydown", keyHandler));

	// PC 端：滚轮翻页（passive: false 以便 handleWheel 中 preventDefault 生效）
	const wheelHandler = (event: WheelEvent) => this.handleWheel(event);
	doc.addEventListener("wheel", wheelHandler, { passive: false });
	cleanups.push(() => doc.removeEventListener("wheel", wheelHandler));

		// 移动端：点击翻页（capture 阶段，先于 foliate 自身处理器）
		if (Platform.isMobile) {
			const tapHandler = (event: MouseEvent) => this.handleTapZone(event);
			doc.addEventListener("click", tapHandler, true);
			cleanups.push(() => doc.removeEventListener("click", tapHandler, true));
		}

		this.documentKeyboardCleanups.set(doc, () => {
			for (const fn of cleanups) fn();
		});
	}







	private applyFoliateAppearance(size = this.currentFontSize): void {
		if (!this.foliateView) {
			return;
		}
		const colors = this.themeManager.resolveThemeColors(this.currentTheme);
		const css = [
			":root { color-scheme: light dark; }",
			"body {",
			`  background-color: ${colors.background} !important;`,
			`  color: ${colors.textColor} !important;`,
			`  font-size: ${size}px !important;`,
			"  line-height: 1.72 !important;",
			"}",
			"p, div, span, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, dt, dd {",
			`  color: ${colors.textColor} !important;`,
			"}",
			`a, a:link, a:visited { color: ${colors.linkColor} !important; }`,
			`::selection { background: ${colors.selectionBg} !important; }`,
			"img { max-width: 100% !important; height: auto !important; }",
		].join("\n");
		this.foliateView.renderer?.setStyles?.(css);
		this.foliateView.renderer?.render?.();

		// obsidian 主题下，外层容器背景使用 CSS 变量，确保 Obsidian 主题切换时
		// readerContainerEl 能实时跟随，无需等待 JS 重新解析。
		const containerBg = this.currentTheme === "obsidian"
			? "var(--background-primary)"
			: colors.background;
		(this.foliateView as unknown as HTMLElement).style.backgroundColor = containerBg;
		this.readerContainerEl.style.backgroundColor = containerBg;
	}

	private applyFoliateLayout(): void {
		if (!this.foliateView) {
			return;
		}
		const attrs: Record<string, string> = {
			flow: this.currentFlowMode,
			margin: this.currentFlowMode === "paginated" ? "28px" : "0px",
			gap: "8%",
			"max-inline-size": "760px",
		};
		const host = this.foliateView as unknown as HTMLElement;
		const renderer = this.foliateView.renderer as unknown as HTMLElement | undefined;
		for (const [name, value] of Object.entries(attrs)) {
			host.setAttribute(name, value);
			renderer?.setAttribute?.(name, value);
		}
		this.foliateView.renderer?.render?.();
	}

	private findIframeForDocument(doc: Document): HTMLIFrameElement | null {
		const frameElement = doc.defaultView?.frameElement;
		if (frameElement instanceof HTMLIFrameElement) {
			return frameElement;
		}

		const contentFrame = this.foliateView?.renderer?.getContents?.()
			.find((content) => content.doc === doc)?.doc?.defaultView?.frameElement;
		if (contentFrame instanceof HTMLIFrameElement) {
			return contentFrame;
		}

		const visit = (root: ParentNode): HTMLIFrameElement | null => {
			const iframes = Array.from(root.querySelectorAll("iframe"));
			for (const iframe of iframes) {
				try {
					if (iframe.contentDocument === doc) {
						return iframe as HTMLIFrameElement;
					}
				} catch {
					/* cross-origin iframes are not expected, but ignore defensively */
				}
			}
			const elements = Array.from(root.querySelectorAll("*"));
			for (const element of elements) {
				const shadowRoot = (element as HTMLElement).shadowRoot;
				if (!shadowRoot) {
					continue;
				}
				const found = visit(shadowRoot);
				if (found) {
					return found;
				}
			}
			return null;
		};
		return visit(this.readerContainerEl);
	}

	/**
	 * 穿透 shadow DOM 收集所有 foliate iframe 的 contentDocument，供全文搜索使用。
	 * currentLoadedDoc 可能因翻页被 foliate 清空，这里实时遍历最可靠。
	 */
	private collectFoliateDocs(): Document[] {
		const docs: Document[] = [];
		const seen = new Set<Document>();
		const visit = (root: ParentNode): void => {
			const iframes = Array.from(root.querySelectorAll("iframe"));
			for (const iframe of iframes) {
				try {
					const d = (iframe as HTMLIFrameElement).contentDocument;
					if (d && d.body && !seen.has(d)) {
						seen.add(d);
						docs.push(d);
					}
				} catch {
					/* cross-origin iframe, ignore */
				}
			}
			const elements = Array.from(root.querySelectorAll("*"));
			for (const element of elements) {
				const shadowRoot = (element as HTMLElement).shadowRoot;
				if (shadowRoot) {
					visit(shadowRoot);
				}
			}
		};
		visit(this.readerContainerEl);
		// 加上缓存的 currentLoadedDoc 兜底
		if (this.currentLoadedDoc?.body && !seen.has(this.currentLoadedDoc)) {
			docs.push(this.currentLoadedDoc);
		}
		return docs;
	}

	/** 安全持久化设置（视图生命周期内 plugin 应已注入） */
	private async saveSettingsSafe(): Promise<void> {
		try {
			await this.plugin?.saveSettings();
		} catch {
			/* 设置保存失败不应阻断朗读 */
		}
	}

	// ================================================================
	// 工具栏搜索（从侧栏移到工具栏）
	// ================================================================

	private toggleToolbarSearch(): void {
		const existing = this.toolbarEl.querySelector(".epub-viewer-epub-toolbar-search");
		if (existing) { existing.remove(); return; }
		const container = this.toolbarEl.createDiv({ cls: "epub-viewer-epub-toolbar-search" });
		const input = container.createEl("input", {
			cls: "epub-viewer-epub-toolbar-search-input",
			attr: { type: "text", placeholder: t("aria.searchBody") },
		}) as HTMLInputElement;
		const results = container.createDiv({ cls: "epub-viewer-epub-toolbar-search-results" });
		input.addEventListener("keydown", (ev: KeyboardEvent) => { ev.stopPropagation(); }, { capture: true });
		let timer: number | null = null;
		input.addEventListener("input", () => {
			if (timer !== null) window.clearTimeout(timer);
			timer = window.setTimeout(() => { timer = null; void this.doToolbarSearch(input.value, results); }, 300);
		}, { passive: true });
		input.addEventListener("keydown", (ev) => {
			if (ev.key === "Escape") { container.remove(); }
			if (ev.key === "Enter") { void this.doToolbarSearch(input.value, results); }
		});
		input.focus();
	}

	private async doToolbarSearch(query: string, resultsEl: HTMLElement): Promise<void> {
		resultsEl.empty();
		if (!query.trim() || query.trim().length < 2 || !this.foliateView) return;

		// 使用 foliate 内置全书搜索（支持跨章节、返回 CFI 可直接导航）
		const searchGen = (this.foliateView as any).search?.({ query: query.trim() });
		if (!searchGen || typeof searchGen[Symbol.asyncIterator] !== 'function') {
			// foliate 不支持 search，回退到当前 section
			resultsEl.createDiv({ cls: "epub-viewer-epub-toolbar-search-empty", text: t("epub.searchUnsupported") });
			return;
		}

		const hits: Array<{ cfi: string; label: string; excerpt: { pre: string; match: string; post: string } }> = [];
		let searching = true;

		// 添加进度指示
		const progressEl = resultsEl.createDiv({ cls: "epub-viewer-epub-toolbar-search-progress", text: t("epub.searching") });

		try {
			for await (const result of searchGen) {
				if (result === 'done') break;
				if (result.progress !== undefined) {
					progressEl.textContent = t("epub.searchProgress", { percent: Math.round(result.progress * 100) });
					continue;
				}
				if (result.subitems) {
					for (const item of result.subitems) {
						hits.push({ cfi: item.cfi, label: result.label || '', excerpt: item.excerpt });
						if (hits.length >= 100) break;
					}
				} else if (result.cfi) {
					hits.push({ cfi: result.cfi, label: result.label || '', excerpt: result.excerpt });
				}
				if (hits.length >= 100) break;
			}
		} catch (e) {
			console.error("epub-viewer: search error", e);
		}

		progressEl.remove();

		if (hits.length === 0) {
			resultsEl.createDiv({ cls: "epub-viewer-epub-toolbar-search-empty", text: t("epub.searchNoMatch") });
			return;
		}

		// 按章节分组显示
		let currentLabel = '';
		for (const h of hits) {
			if (h.label && h.label !== currentLabel) {
				currentLabel = h.label;
				resultsEl.createDiv({ cls: "epub-viewer-epub-toolbar-search-chapter", text: currentLabel });
			}
			const btn = resultsEl.createEl("button", { cls: "epub-viewer-epub-toolbar-search-hit", attr: { type: "button" } });
			btn.createSpan({ text: h.excerpt.pre });
			btn.createEl("strong", { text: h.excerpt.match });
			btn.createSpan({ text: h.excerpt.post });
			btn.addEventListener("click", () => {
				if (this.foliateView) {
					void this.foliateView.goTo(h.cfi);
				}
			});
		}
	}
}
