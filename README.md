# llm-d 中文文档（v0.10）

[llm-d 官方文档](https://llm-d.ai/docs)的非官方中文翻译，基于 [llm-d/llm-d.github.io](https://github.com/llm-d/llm-d.github.io) 网站源码构建。原文版权归 llm-d a Series of LF Projects, LLC 所有，依据 Apache License 2.0 翻译与再分发；如有出入，以英文原版为准。

## 本地浏览

需要 Node.js **24 或更新版本**以及 npm。

```sh
git clone https://github.com/iamaaronyu/llm-d-doc-cn.git
cd llm-d-doc-cn
npm ci
npm run build
npm run serve -- --host 127.0.0.1 --port 3000
```

打开 http://127.0.0.1:3000/docs 。构建结果包含中文全文搜索索引、文档图片和本地公式样式及字体。

在 macOS 上完成首次安装和构建后，也可以双击仓库内的「打开中文文档.command」，自动启动后台服务并打开浏览器；双击「停止中文文档.command」停止服务。默认使用 3000 端口，若已占用则自动选择 3001–3020 端口。

也可通过命令启动或停止后台服务：

```sh
node local-preview.cjs start
node local-preview.cjs stop
```

## 内容与维护

- `docs/`：中文文档和侧边栏配置，直接保存在本仓库。
- `src/`：网站页面、主题与样式。
- `static/`：图片、公式样式及字体。
- `TRANSLATION_GLOSSARY.md`：翻译术语表。
- `README.upstream.md`：原项目说明，供参考。
- `.github/upstream-workflows/`：归档的原项目工作流，不会执行。

维护中文内容后运行 `npm run build` 即可。原项目的 `sync`、`build:all`、`build:full` 会从英文上游同步内容，不适用于日常中文站点构建。

本仓库提交网站源码与中文内容；`node_modules/`、`build/`、独立 Node 运行环境、日志和本地服务状态不纳入版本控制。当前未启用自动部署或上游同步。

## 许可

保留原项目 [Apache License 2.0](LICENSE) 许可证及版权声明。
