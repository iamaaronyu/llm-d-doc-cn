# llm-d 基础设施提供商

本目录包含在各 Kubernetes 提供商上部署 llm-d 的专属文档，以及故障排查和已知问题。

## 其他提供商 {#other-providers}

要把新的基础设施提供商加入成熟路径，我们需要以下支持：

* 说明如何配置该平台以支持一个或多个[成熟路径指南](https://github.com/llm-d/llm-d/tree/v0.10.0/guides)的文档
* 向指南贡献相应的配置，以处理该提供商特有的差异
* 一个用于验证受支持指南的自动化测试环境
* 至少一名有文档记录的平台维护者，负责响应 GitHub issue，并能在 llm-d Slack 频道 `#sig-installation` 中参与定期讨论。
