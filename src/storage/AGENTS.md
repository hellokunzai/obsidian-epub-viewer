# storage/
> L2 | 父级: Epub Viewer 插件模块索引

成员清单
types.ts: EPUB 阅读设置、阅读进度、主题、扩展名的类型真相源。
readingProgress.ts: 阅读进度持久化后端，进度存于插件 data.json，不污染 vault。

法则: 设置即配置·进度集中持久·data.json 单一真相

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
