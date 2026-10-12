import { moment } from "obsidian";

/**
 * Internationalization for Epub Viewer.
 * All user-visible strings must go through t(). zh-cn is the default UI language;
 * everything else falls back to English.
 *
 * 纯 EPUB 阅读器：仅保留 书架 / 阅读器 / 设置 / 主题 相关的文案键。
 * 批注、标签、深链、导出、侧栏总览等键已全部移除。
 */

type Dict = Record<string, string>;

const locale = moment.locale();
const isZh = locale === "zh-cn" || locale === "zh" || locale.startsWith("zh");

const en: Dict = {
  // Commands
  "command.openBookshelf": "Open EPUB bookshelf",

  // Common
  "common.more": "More",
  "common.unknownChapter": "Unknown chapter",
  "common.chapterLabel": "Chapter {{index}}",

  // Settings
  "settings.epub.heading": "EPUB reading",
  "settings.epub.fontSize.name": "Reading font size",
  "settings.epub.fontSize.desc": "Base font size (px) for EPUB body text. Reopen the book to apply.",
  "settings.epub.theme.name": "Reading theme",
  "settings.epub.theme.desc": "Background and text colors of the EPUB reading area.",
  "settings.epub.flow.name": "Page mode",
  "settings.epub.flow.desc": "Paginated shows one page; scrolled is continuous.",
  "settings.epub.flow.paginated": "Paginated",
  "settings.epub.flow.scrolled": "Continuous scroll",

  // Bookshelf
  "bookshelf.title": "EPUB Library",
  "bookshelf.empty": "No e-book files found in the vault.",
  "bookshelf.lastRead": "Last read: {{chapter}} · {{date}}",
  "bookshelf.readTime": "Read {{time}}",
  "bookshelf.remaining": "About {{minutes}} min left",
  "bookshelf.displayName": "EPUB Library",
  "bookshelf.hours": "{{count}} h",
  "bookshelf.minutes": "{{count}} m",
  "bookshelf.seconds": "{{count}} s",

  // aria-labels
  "aria.themeTrigger": "Reading theme",
  "aria.toggleSidebar": "Toggle sidebar",
  "aria.decreaseFont": "Decrease font size",
  "aria.increaseFont": "Increase font size",
  "aria.searchFull": "Search full text",
  "aria.prevPage": "Previous page",
  "aria.nextPage": "Next page",
  "aria.searchPlaceholder": "Filter chapters…",
  "aria.searchBody": "Search body…",
  "aria.filterToc": "Filter table of contents",
  "aria.clearSearch": "Clear filter",

  // EPUB reader
  "epub.emptyToc": "No table of contents found.",
  "epub.tocNoMatch": "No matching chapters",
  "epub.searchUnsupported": "Search not supported",
  "epub.searching": "Searching...",
  "epub.searchProgress": "Searching {{percent}}%",
  "epub.searchNoMatch": "No matching content found",
  "epub.loadFailed": "Epub Viewer EPUB failed to load: {{error}}",
  "epub.tapPageOn": "Tap-to-page enabled",
  "epub.swipePageOn": "Swipe-to-page enabled",
  "epub.keyboardPageOn": "Keyboard paging enabled",
  "epub.scrollPageOn": "Scroll paging enabled",
  "epub.toggleScroll": "Switch to scroll",
  "epub.togglePaginate": "Switch to paginated",
  "epub.toggleToSwipe": "Switch to swipe paging",
  "epub.toggleToTap": "Switch to tap paging",
  "epub.toggleToWheel": "Switch to wheel paging",
  "epub.toggleToKeyboard": "Switch to keyboard paging",

  // Themes
  "theme.follow": "Follow Obsidian",
  "theme.white": "White",
  "theme.warm": "Warm",
  "theme.green": "Eye-care green",
  "theme.sepia": "Sepia",
  "theme.dark": "Dark",
};

const zh: Dict = {
  // Commands
  "command.openBookshelf": "打开 EPUB 书架",

  // Common
  "common.more": "更多",
  "common.unknownChapter": "未知章节",
  "common.chapterLabel": "章节 {{index}}",

  // Settings
  "settings.epub.heading": "EPUB 阅读",
  "settings.epub.fontSize.name": "阅读字号",
  "settings.epub.fontSize.desc": "EPUB 正文基础字号（px）。修改后重新打开电子书生效。",
  "settings.epub.theme.name": "阅读主题",
  "settings.epub.theme.desc": "EPUB 阅读区背景与文字配色。",
  "settings.epub.flow.name": "翻页模式",
  "settings.epub.flow.desc": "翻页为分页布局；滚动为连续滚动阅读。",
  "settings.epub.flow.paginated": "翻页",
  "settings.epub.flow.scrolled": "连续滚动",

  // Bookshelf
  "bookshelf.title": "📚 电子书书架",
  "bookshelf.empty": "Vault 中没有找到电子书文件。",
  "bookshelf.lastRead": "上次阅读：{{chapter}} · {{date}}",
  "bookshelf.readTime": "已读 {{time}}",
  "bookshelf.remaining": "剩余约 {{minutes}} 分钟",
  "bookshelf.displayName": "EPUB 书架",
  "bookshelf.hours": "{{count}}小时",
  "bookshelf.minutes": "{{count}}分",
  "bookshelf.seconds": "{{count}}秒",

  // aria-labels
  "aria.themeTrigger": "阅读主题",
  "aria.toggleSidebar": "切换侧边栏",
  "aria.decreaseFont": "缩小字号",
  "aria.increaseFont": "放大字号",
  "aria.searchFull": "搜索全文",
  "aria.prevPage": "上一页",
  "aria.nextPage": "下一页",
  "aria.searchPlaceholder": "筛选章节…",
  "aria.searchBody": "搜索正文…",
  "aria.filterToc": "筛选目录",
  "aria.clearSearch": "清空筛选",

  // EPUB reader
  "epub.emptyToc": "未找到目录信息。",
  "epub.tocNoMatch": "未找到匹配章节",
  "epub.searchUnsupported": "搜索功能不支持",
  "epub.searching": "搜索中...",
  "epub.searchProgress": "搜索中 {{percent}}%",
  "epub.searchNoMatch": "未找到匹配内容",
  "epub.loadFailed": "Epub Viewer EPUB 加载失败: {{error}}",
  "epub.tapPageOn": "点按翻页已开启",
  "epub.swipePageOn": "滑动翻页已开启",
  "epub.keyboardPageOn": "键盘翻页已开启",
  "epub.scrollPageOn": "滚轮翻页已开启",
  "epub.toggleScroll": "切换为滚动",
  "epub.togglePaginate": "切换为分页",
  "epub.toggleToSwipe": "切换为滑动翻页",
  "epub.toggleToTap": "切换为点按翻页",
  "epub.toggleToWheel": "切换为滚轮翻页",
  "epub.toggleToKeyboard": "切换为键盘翻页",

  // Themes
  "theme.follow": "跟随 Obsidian",
  "theme.white": "默认白",
  "theme.warm": "暖光",
  "theme.green": "护眼绿",
  "theme.sepia": "羊皮纸",
  "theme.dark": "夜间",
};

const strings: Dict = isZh ? zh : en;

export function t(key: string, params?: Record<string, string | number>): string {
  let text = strings[key] ?? en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`{{${k}}}`, "g"), String(v));
    }
  }
  return text;
}
