# llm-d 中文文档（v0.10）

本仓库是 [llm-d.ai/docs](https://llm-d.ai/docs)（v0.10）的**非官方中文翻译**，基于官方站点源码 [llm-d/llm-d.github.io](https://github.com/llm-d/llm-d.github.io)（Apache License 2.0）改造而来。原文版权归 llm-d a Series of LF Projects, LLC 所有，如有出入，以英文原版为准。

## 内容

- `docs/`：95 篇已翻译的文档（Markdown / MDX）。代码、命令、YAML 键名、指标名保持原文，注释与说明已翻译；所有小节标题都带有与英文原版一致的锚点（`{#english-slug}`），原有的 `#锚点` 链接依然有效。
- `docs/menu-config.json`：侧边栏分类与页面的中文名称。
- `TRANSLATION_GLOSSARY.md`：术语对照表。
- `docusaurus.config.js`：已改为 `zh-Hans` 语言，移除了博客、社区、版本切换和第三方聊天组件，页脚加入了翻译声明。
- `tools/static-build/`：不依赖 Docusaurus 的轻量静态构建器（marked + highlight.js + KaTeX）。

## 方式一：用 Docusaurus 构建（与官网一致）

需要 Node.js 20+：

```bash
npm install
npm run build        # 输出到 build/
npm run serve        # 本地预览
```

## 方式二：轻量静态构建

```bash
npm install marked highlight.js katex --no-save --prefix /tmp/sb
node tools/static-build/build.mjs build-static /tmp/sb/node_modules
# 然后用任意静态服务器打开 build-static/index.html
```
