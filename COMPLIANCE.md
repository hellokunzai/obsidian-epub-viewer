# Obsidian 社区插件上架合规核查

> 核查日期：2026-10-12
> 插件：`epub-viewer` v0.2.0（minAppVersion 1.7.2）
> 结论：**已基本达标。原硬性阻塞项（缺发布 CI）已通过补齐发布工作流解决；剩余为移动端核验、打 tag、提交 PR 等非代码步骤。**

---

## ✅ 已通过项（合规）

| 检查项 | 结果 | 说明 |
| --- | --- | --- |
| 必备文件 | ✅ | `manifest.json` / `main.js`（已重建）/ `versions.json` 齐全；`LICENSE`（MIT）、`README.md`、`README.en.md` 均在 |
| manifest 必填字段 | ✅ | `id`=`epub-viewer`（合法）、`name`、`version`、`minAppVersion`、`author`、`isDesktopOnly` 全部存在 |
| manifest 描述长度 | ✅ | **216 字符**（≤250） |
| manifest 描述禁词 | ✅ | 已移除 "Obsidian" 一词 |
| manifest 描述结尾 | ✅ | 以 `.` 结尾（社区商店 `validate-plugin-entry` 机器人强制要求 `.`/`?`/`!`/`)`） |
| 禁止 API（`eval`/`new Function`） | ✅ | 打包后的 `main.js` 中**无任何** `eval`/`new Function`/`Function(` |
| 远程代码加载 | ✅ | 未发现远程脚本/资源拉取；扫描到的 http(s) 均为 EPUB 解析用的 XML 命名空间 URI（Dublin Core、ONIX、PRISM 等） |
| 内容安全（XSS） | ✅ | `transformFoliateMarkup` 剥离 `<script>`/`<iframe>`/`on*`/`javascript:`；仅对已净化文档做 `outerHTML` 序列化，无未信任 HTML 注入 |
| 国际化对齐 | ✅ | `en`/`zh` 字典 **56/56 键、零漂移**；所有用户可见文案均经 `t()` |
| 构建产物 | ✅ | `npm run build` 通过，`main.js` 已基于最新源码重建 |

---

## 🟢 原硬性阻塞项（已解决）

### 1. 缺少 GitHub 发布工作流 `.github/workflows` —— ✅ 已补齐
已新增三套工作流，覆盖「能编译 / 版本号对 / 发得出」：
- `release.yml`：push tag（如 `0.2.0`，**不加 `v` 前缀**）或手动 Run 触发 → `npm ci` → `npm run build` → `check-version` 守门 → `gh release create` 上传 `main.js`/`manifest.json`/`styles.css`，**不带 `--draft`**。
- `ci.yml`：push/PR 到 `main` 时跑 `typecheck` + `build`，并断言三个产物存在（`main.js` 被 gitignore，必须由 CI 现场构建）。
- `version-check.yml`：push/PR/tag 时校验 manifest/package.json/versions.json 三处版本号一致，且 manifest 的 id/name/description 符合商店红线。
- `.github/scripts/check-version.mjs`：本地与 CI 共用的版本一致性 + manifest 合规检查脚本（`node .github/scripts/check-version.mjs [--tag X.Y.Z]`）。

> 发版注意：tag **不要加 `v` 前缀**；`release.yml` 已做 `${VERSION#v}` 容错剥离。Release 不带 `--draft`，否则社区商店查无此版。

---

## ⚠️ 待办 / 建议（非硬性，但建议处理）

1. **移动端声明核验**：`manifest.json` 中 `isDesktopOnly: false` 声明支持移动端。foliate-js 依赖 iframe/webview，需在真实 Obsidian 移动端验证能否正常渲染；若不行，应改为 `isDesktopOnly: true`。
2. **`authorUrl` 指向核对**：manifest 已填 `authorUrl`（`https://github.com/hellokunzai/obsidian-book-note`）。非强制，但请确认该地址是否为本插件实际仓库，避免指向错误项目。
3. **日志串语言一致性**：`src/epub/EpubFoliateLoader.ts:53` 的 `console.warn` 含中文（非用户可见 UI，仅开发控制台）。建议统一为英文，保持代码语言一致。
4. **i18n 检查器误报**：内置 `obsidian-plugin-dev` 的 `i18n-check.js` 对本项目的扁平 `en`/`zh` 布局识别有误，误把无关 token 当作"第二语言表"，谎报 54 个问题。手动逐键核对确认真实 i18n 完全合规。如需，可修补检查器或直接忽略该误报。

---

## 🛠 本次已完成的修复

| 文件 | 改动 |
| --- | --- |
| `manifest.json` | `description` 改为合规文案（216 字符、无 "Obsidian"、**以 `.` 结尾**，满足社区商店强制尾标点要求） |
| `package.json` | 将陈旧的"批注"描述更新为准确的阅读器描述 |
| `src/i18n/index.ts` | 新增 3 个键：`settings.epub.flow.paginated`、`settings.epub.flow.scrolled`、`common.chapterLabel`（含 `{{index}}` 参数），`en`/`zh` 同步 |
| `src/settings/settingsTab.ts` | 翻页模式下拉选项由写死中文改为 `t("settings.epub.flow.paginated"/"scrolled")` |
| `src/epub/EpubReaderView.ts` | 目录无标题兜底标签由写死中文 `章节 N` 改为 `t("common.chapterLabel", { index })` |
| `main.js` | 重新构建，包含上述源码改动 |
| `.github/workflows/` + `.github/scripts/` | 新增发布工作流：`release.yml`、`ci.yml`、`version-check.yml` 与共用脚本 `check-version.mjs` |

---

## 后续动作清单

- [x] 补齐 `.github/workflows` 发布工作流（阻塞项，已完成）
- [ ] 在真机移动端验证渲染；必要时将 `isDesktopOnly` 置 `true`
- [ ] 视情况补 `authorUrl`
- [ ] （可选）统一 `console.warn` 日志语言
- [ ] 打 Release tag（如 `0.2.0`）并确认三个产物随 tag 发布
- [ ] 向 `obsidianmd/obsidian-releases` 提交社区插件 PR
