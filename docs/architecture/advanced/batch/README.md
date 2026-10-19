# 批量推理

llm-d 通过两个组件支持批处理和离线推理工作负载，它们可以独立部署，也可以一起部署：

- **[批处理网关（Batch Gateway）](batch-gateway.md)**——兼容 OpenAI 的 Batch API（`/v1/batches`、`/v1/files`），用于提交、跟踪和管理批量推理作业。包括一个 API 服务器和一个处理器，处理器把单个推理请求分发给 llm-d 路由器。

- **[异步处理器（Async Processor）](async-processor.md)**——一个轻量级分发代理，从消息队列（如 Redis 和 Google Pub/Sub）中拉取单个推理请求并发送给 llm-d 路由器，同时根据系统指标调节流量。

两者一起部署时，批处理网关会把单个请求交给异步处理器，而不是直接分发，从而获得基于指标的流量控制。
