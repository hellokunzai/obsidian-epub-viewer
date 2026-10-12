# Epub Viewer

一个干净、专注的 Obsidian 电子书阅读器。在 vault 里直接打开 EPUB、MOBI、AZW3、FB2、FBZ、CBZ 与 TXT，享受分页或连续滚动、可调字号、阅读主题、目录、全文搜索、带进度的书架以及阅读时长统计——全程不离开你的 vault。

> 纯阅读器定位：插件**不修改你的原始电子书文件**，也**不向 vault 写入任何笔记/标注**，所有阅读进度都只保存在插件自己的 `data.json` 中。

---

## 功能特性

- **多格式支持**：EPUB、MOBI、AZW3、FB2、FBZ、CBZ、TXT。点击 vault 中的任意上述格式文件即可在阅读器中打开；扩展名与阅读视图的绑定做了冲突防护，不会因与其他插件争用扩展名而崩溃。
- **两种翻页模式**：分页（paginated）与连续滚动（scrolled），可在设置中设定默认模式，也可在阅读器工具栏随时切换。
- **字号调节**：工具栏 `A-` / `A+` 即时调整，设置页提供 12–28px 滑块，默认 16px。
- **阅读主题（6 种）**：跟随 Obsidian（Obsidian 主题切换时通过 `MutationObserver` 自动同步）、白、暖光、护眼绿、羊皮纸、夜间。工具栏右侧色块下拉可随时切换。
- **目录侧栏**：折叠式目录树，支持按标题搜索与筛选，当前章节高亮。
- **全文搜索**：阅读器顶部搜索栏对整个书籍正文进行检索，带进度提示。
- **书架视图**：在右侧栏列出 vault 内全部电子书，每张卡片显示
  - 阅读进度条与百分比
  - 上次阅读时间
  - 累计已读时长
  - 预估剩余分钟数
- **阅读进度持久化**：自动保存当前位置（CFI / 章节 / 百分比 / 时间戳）到插件 `data.json`，下次打开自动续读，且通过防抖写入避免频繁 I/O。
- **阅读时长统计**：后台累计阅读秒数，并在书架中估算剩余时间。
- **国际化**：默认中文（zh-cn），其余环境回退英文。
- **移动端友好**：支持移动端点击/滑动翻页切换，并提供隐藏底部导航栏的阅读沉浸模式。

---

## 安装

### 方式一：社区插件商店（推荐，待上架后）
1. 打开 Obsidian 设置 → 第三方插件 → 浏览。
2. 搜索 **Epub Viewer**，点击安装并启用。

### 方式二：BRAT 测试版
1. 安装 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 插件。
2. 通过 BRAT 添加 Beta 插件仓库 `hellokunzai/obsidian-epub-viewer`。

### 方式三：手动安装
1. 从 [Releases](https://github.com/hellokunzai/obsidian-epub-viewer/releases) 下载 `main.js`、`manifest.json`、`styles.css`。
2. 放入 `你的Vault/.obsidian/plugins/epub-viewer/` 目录（目录不存在则新建）。
3. 在 Obsidian 设置 → 第三方插件中启用 **Epub Viewer**。

---

## 使用

- **打开一本书**：在文件列表中点击任意支持的电子书文件，或在命令面板运行「打开电子书书架」（`open-epub-bookshelf`）后从书架选择。
- **翻页 / 滚动**：工具栏的翻页图标在分页与连续滚动间切换；移动端可在「点击翻页」与「滑动翻页」间切换，桌面端可在「滚轮翻页」与「键盘翻页」间切换。
- **调整阅读体验**：工具栏可改字号、切主题、展开目录、呼出全文搜索；更多操作收纳在「更多」溢出菜单。
- **查看进度**：右侧栏书架视图常驻展示所有书本的进度与阅读数据。

---

## 设置

在 Obsidian 设置 → Epub Viewer 中可配置：

| 选项 | 说明 | 默认值 |
| --- | --- | --- |
| 默认翻页模式 | 分页 或 连续滚动 | 连续滚动（scrolled） |
| 默认字号 | 12–28px 滑块 | 16px |
| 阅读主题 | 跟随 Obsidian / 白 / 暖光 / 护眼绿 / 羊皮纸 / 夜间 | 跟随 Obsidian |

---

## 安全说明

插件在渲染电子书时做了多重安全处理，避免恶意 EPUB 在 iframe 中执行代码：

- **内容净化**：剥离 `<script>`、`<iframe>`、`<object>`、`<embed>`，移除 `on*` 事件属性、`srcdoc`，以及 `javascript:` / `vbscript:` / 危险 `data:` 协议 URL。
- **CSP 兼容**：Obsidian 在 iframe 中会拦截 `blob:` / `data:` 样式表，插件会将这些样式表内联为 `<style>`，既保证排版正确又避开 CSP 限制。
- **插件共存防护**：foliate 自定义元素注册被加了一层守卫，避免与本机其他基于 foliate 的插件（如 weave）重复 `define` 同名元素而报错。

---

## 技术架构

阅读引擎基于 [foliate-js](https://github.com/johnfactotum/foliate-js)（^1.0.1），使用 esbuild 打包为 CJS。

```
main.ts
└─ EpubViewerPlugin（插件装配根）
   ├─ EpubReaderView        阅读器视图（工具栏 / 目录侧栏 / 进度条 / 全文搜索 / 阅读时长）
   ├─ EpubBookshelfView     书架视图（遍历 vault 电子书、展示进度与阅读数据）
   ├─ EpubViewerSettingsTab 设置页
   └─ ReadingProgressStore  进度存储（内存缓存 + 防抖持久化到 data.json）
       ├─ EpubThemeManager        主题注册 / 应用 / 颜色解析 / 跟随 Obsidian 主题
       ├─ EpubChapterResolver     TOC 树拍平、spine 映射、CFI 规范化
       ├─ EpubFoliateLoader       foliate 引擎加载、TXT 特例、安全管道
       ├─ EpubFoliateGuard        自定义元素注册守卫（防多插件冲突）
       ├─ EpubFoliatePatches      blob iframe / CSP 补丁
       └─ EpubStylesheetInliner   样式表内联与内容净化
   └─ i18n                   zh-cn / en 双语字典
```

---

## 开发构建

环境要求：Node.js（含 npm）。

```bash
npm install        # 安装依赖
npm run dev        # 监听模式，实时重建 main.js
npm run build      # 生产构建（无 sourcemap）
npm run typecheck  # 类型检查
```

构建产物 `main.js` 由 `esbuild.config.mjs` 从 `main.ts` 打包生成，目标 `es2020`、CJS 格式，external 依赖含 `obsidian`、`electron`、`@codemirror/*` 及 Node 内置模块。

---

## 版本兼容

- 最低 Obsidian 版本：`1.7.2`（见 `manifest.json` 与 `versions.json`）。
- 桌面端与移动端均支持（`isDesktopOnly: false`）。

---

## 许可证

[MIT](./LICENSE) © 2026 hellokunzai
