# src/
> L2 | 父级: Epub Viewer 插件模块索引

成员清单
storage/types.ts: EPUB 阅读设置、阅读进度、主题与扩展名类型的真相源。
storage/readingProgress.ts: 阅读进度持久化入口，进度存于插件 data.json，不污染 vault。
settings/settingsTab.ts: 插件设置页，管理 EPUB 阅读偏好（字号 / 主题 / 翻页）。
epub/EpubReaderView.ts: foliate 阅读器视图，承载工具栏、目录、进度、主题、字号、翻页与搜索。
epub/EpubBookshelfView.ts: 书架侧栏视图，展示 vault 内电子书的阅读进度与阅读时长。
epub/EpubChapterResolver.ts: CFI/百分比归一化与章节标签解析。
epub/EpubThemeManager.ts: 主题颜色解析。
epub/EpubStylesheetInliner.ts: EPUB 样式安全过滤与脚本剥离。
epub/EpubFoliateLoader.ts: foliate-js 引擎加载。
i18n/index.ts: EN+ZH 双语键。

法则: 类型单一真相·进度集中持久·业务不懂存储·渲染只做投影·UI 只做交互

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
