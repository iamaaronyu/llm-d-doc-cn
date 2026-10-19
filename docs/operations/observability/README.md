# 可观测性

借助 Prometheus 指标、Grafana 仪表盘和 OpenTelemetry 分布式追踪来监控和调试 llm-d 部署。

:::note
每份成熟路径指南都会链接到这里进行可观测性配置。只需安装一次这套技术栈，即可在各个指南中复用。
:::


## 文档 {#documentation}

* [部署](./setup.md)——安装 Prometheus 和 Grafana、加载仪表盘并部署追踪后端
* [指标](./metrics.md)——启用并解读模型服务器和 EPP 指标
* [分布式追踪](./tracing.md)——在 vLLM、路由代理和 EPP 之间配置 OpenTelemetry
* [PromQL 参考](./promql.md)——可直接用于仪表盘和告警的查询
* [告警](./alerting.md)——应用默认的 EPP Prometheus 告警规则
* [GKE TPU 可观测性](./tpu.md)——解读 TPU 硬件指标并排查数据缺失问题

## 可运行的资源 {#runnable-assets}

脚本、Grafana 仪表盘 JSON、告警规则和追踪清单位于 llm-d 仓库的 [`guides/recipes/observability/`](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/recipes/observability/) 目录中（不作为网站页面发布）。
