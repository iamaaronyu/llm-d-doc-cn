# 批处理网关

通过兼容 OpenAI 的 API 处理大规模批量推理作业，使批处理与交互式工作负载能够在共享基础设施上高效共存。

## 何时选择这条路径 {#when-to-pick-this-path}

- 你有不需要实时响应的**离线推理工作负载**（例如评测、向量嵌入、数据集处理）。
- 你希望**利用空闲的加速器容量**来处理批量工作，同时保护交互式流量不受干扰。
- 你的客户端需要一个**兼容 OpenAI 的 Batch API**（`/v1/batches`、`/v1/files`）来提交、跟踪和管理作业。
- 你需要**多租户隔离**——每个租户的作业、文件和结果相互隔离。

## 前提条件 {#prerequisites}

- 一套可用的 llm-d 路由器、推理资源池以及至少一个模型服务器。如果还没有，请从[快速开始](../../../getting-started/quickstart.md)入手。
- 集群可以访问 PostgreSQL（12+）以及 Redis（6+）或 Valkey（8+）。
- 用于存放批处理输入/输出文件的 S3 兼容存储，或访问模式为 `ReadWriteMany`（RWX）的共享 PVC。
- Helm 3.0+。

## 部署 {#deploy}

- [批处理网关部署指南](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/batch-serving/batch-gateway)——完整的部署说明、配置选项和故障排查。

## 相关内容 {#related}

- [批处理网关架构](../../../architecture/advanced/batch/batch-gateway.md)——组件、数据流和处理流水线。
- [批处理网关仓库](https://github.com/llm-d/llm-d-batch-gateway)——源代码、Helm Chart、各平台部署指南和演示脚本。
- [异步处理](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/batch-serving/asynchronous-processing)——针对单个请求的、基于队列的异步推理，与批处理网关互补。
