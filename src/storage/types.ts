/**
 * [INPUT]: 依赖 Obsidian 插件设置与 EPUB 阅读/进度领域约束
 * [OUTPUT]: 对外提供 EPUB 阅读设置、阅读进度、主题与扩展名类型
 * [POS]: storage 模块的类型真相源，被 epub、settings 与进度 store 共享
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

import { t } from "../i18n";

export interface EpubViewerSettings {
  // --- EPUB 阅读 ---
  epubDefaultFlow: EpubFlowMode;
  epubFontSize: number;
  epubReadingTheme: EpubReadingTheme;
}

export const DEFAULT_SETTINGS: EpubViewerSettings = {
  epubDefaultFlow: "scrolled",
  epubFontSize: 16,
  epubReadingTheme: "obsidian",
};

export interface EpubReadingProgress {
  cfi: string;
  chapter: string;
  percent: number;
  lastRead: string;
  readingTimeSeconds: number;
  estimatedRemainingMinutes?: number;
}

// ===== EPUB 阅读设置 =====

export type EpubReadingTheme = "obsidian" | "white" | "warm" | "green" | "sepia" | "dark";
export type EpubFlowMode = "paginated" | "scrolled";

export const EPUB_READING_THEMES: { id: EpubReadingTheme; label: string; background: string; text: string; swatch: string }[] = [
  { id: "obsidian", label: t("theme.follow"), background: "", text: "", swatch: "linear-gradient(135deg, #ffffff 50%, #1e1e1e 50%)" },
  { id: "white", label: t("theme.white"), background: "#FFFFFF", text: "#333333", swatch: "#FFFFFF" },
  { id: "warm", label: t("theme.warm"), background: "#FAF9DE", text: "#333333", swatch: "#FAF9DE" },
  { id: "green", label: t("theme.green"), background: "#E3EDCD", text: "#333333", swatch: "#E3EDCD" },
  { id: "sepia", label: t("theme.sepia"), background: "#F4ECD8", text: "#5C4B37", swatch: "#F4ECD8" },
  { id: "dark", label: t("theme.dark"), background: "#1C1C1E", text: "#A8A8A8", swatch: "#1C1C1E" },
];

export const SUPPORTED_BOOK_EXTENSIONS = ["epub", "mobi", "azw3", "fb2", "fbz", "cbz", "txt"] as const;
export type BookFileExtension = (typeof SUPPORTED_BOOK_EXTENSIONS)[number];
