/**
 * [INPUT]: 依赖 Obsidian PluginSettingTab/Setting 与 storage/types 的阅读设置模型
 * [OUTPUT]: 对外提供 EpubViewerSettingsTab，负责 EPUB 阅读设置（字号 / 主题 / 翻页）
 * [POS]: settings 模块的用户配置界面，被 main.ts 注册
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

import { PluginSettingTab, Setting } from "obsidian";
import { t } from "../i18n";

import type EpubViewerPlugin from "../../main";
import {
  EPUB_READING_THEMES,
  EpubFlowMode,
  EpubReadingTheme,
} from "../storage/types";

export class EpubViewerSettingsTab extends PluginSettingTab {
  constructor(private readonly plugin: EpubViewerPlugin) {
    super(plugin.app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.renderEpubSettings();
  }

  /** EPUB 阅读相关设置：字号 / 主题 / 翻页 */
  private renderEpubSettings(): void {
    const { containerEl } = this;
    new Setting(containerEl).setName(t("settings.epub.heading")).setHeading();

    new Setting(containerEl)
      .setName(t("settings.epub.fontSize.name"))
      .setDesc(t("settings.epub.fontSize.desc"))
      .addSlider((slider) => {
        slider
          .setLimits(12, 28, 1)
          .setValue(this.plugin.settings.epubFontSize)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.epubFontSize = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t("settings.epub.theme.name"))
      .setDesc(t("settings.epub.theme.desc"))
      .addDropdown((dropdown) => {
        for (const theme of EPUB_READING_THEMES) {
          dropdown.addOption(theme.id, theme.label);
        }
        dropdown.setValue(this.plugin.settings.epubReadingTheme).onChange(async (value) => {
          this.plugin.settings.epubReadingTheme = value as EpubReadingTheme;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName(t("settings.epub.flow.name"))
      .setDesc(t("settings.epub.flow.desc"))
      .addDropdown((dropdown) => {
        dropdown.addOption("paginated", "翻页");
        dropdown.addOption("scrolled", "滚动");
        dropdown.setValue(this.plugin.settings.epubDefaultFlow).onChange(async (value) => {
          this.plugin.settings.epubDefaultFlow = value as EpubFlowMode;
          await this.plugin.saveSettings();
        });
      });
  }
}
