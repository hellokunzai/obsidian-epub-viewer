/**
 * [INPUT]: 依赖 Obsidian TFile 与插件 data.json 的读写能力
 * [OUTPUT]: 对外提供 ReadingProgressStore，管理 EPUB 阅读进度的内存缓存与持久化
 * [POS]: EPUB 阅读进度的唯一持久化入口；进度存于插件 data.json，不污染 vault
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

import { TFile } from "obsidian";
import { EpubReadingProgress } from "./types";

export type ProgressMap = Record<string, EpubReadingProgress>;

export class ReadingProgressStore {
  private cache = new Map<string, EpubReadingProgress>();
  private onChange?: () => Promise<void>;

  constructor(onChange?: () => Promise<void>) {
    this.onChange = onChange;
  }

  /** 从插件 data.json 中加载进度（由主类在 loadSettings 时调用） */
  hydrate(progress: ProgressMap | undefined): void {
    this.cache.clear();
    if (progress) {
      for (const [path, entry] of Object.entries(progress)) {
        this.cache.set(path, entry);
      }
    }
  }

  /** 导出当前进度快照，供主类持久化到 data.json */
  snapshot(): ProgressMap {
    return Object.fromEntries(this.cache);
  }

  /** 同步读取缓存中的进度（书架 / 进度条使用） */
  getCachedProgress(file: { path: string }): EpubReadingProgress | null {
    return this.cache.get(file.path) ?? null;
  }

  /** 异步读取进度（与缓存一致；进度已全部驻留内存） */
  async getEpubProgress(file: TFile): Promise<EpubReadingProgress | null> {
    return this.cache.get(file.path) ?? null;
  }

  /** 保存进度并触发持久化 */
  async saveEpubProgress(file: TFile, progress: EpubReadingProgress): Promise<void> {
    this.cache.set(file.path, progress);
    await this.onChange?.();
  }
}
