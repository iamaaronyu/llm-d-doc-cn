# 异步处理

异步处理路径为对延迟不敏感的工作负载提供基于队列的推理，或用于填充推理资源池中的“闲置”容量。它把请求提交与执行解耦，使客户端无需维持长连接的 HTTP 会话即可提交大量工作。

## 部署 {#deploy}

使用 Helm 以及受支持的队列实现（Redis 或 GCP Pub/Sub）进行部署的说明，请参阅[异步处理指南](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/batch-serving/asynchronous-processing)。

## 架构 {#architecture}

**异步处理器（Async Processor）**是一个轻量级的分发代理，它从消息队列中拉取请求，并转发给 llm-d 路由器。

### 分发门控 {#dispatch-gating}

为防止后台任务影响实时流量，异步处理器使用**分发门控（Dispatch Gates）**。这些门控根据系统指标调节请求流：

* **Prometheus 门控**：查询模型服务器的饱和度（例如 KV 缓存压力、队列深度），只有在系统有可用“闲置”容量时才分发。
* **预算门控**：使用预先计算的预算来控制吞吐量。
* **优先级与截止时间**：请求可以设置优先级，处理器会强制执行截止时间，确保放弃已过期的工作。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)">
    <img src="/img/versioned/0.10/assets/async-processor.svg" alt="异步处理器架构">
  </picture>
</p>

### 弹性 {#resilience}

* **重试**：临时性故障（如限流或网络问题）会以指数退避方式自动重新入队。
* **并发控制**：可配置的工作线程池让你调节后台处理的并行度。

## 使用场景 {#use-cases}

* **批量推理**：处理大型数据集，完成时间以分钟或小时计，而不是毫秒。
* **填充闲置容量**：利用实时请求高峰之间的空闲 GPU 周期执行后台任务，如文档摘要或向量嵌入生成。
* **离线评测**：运行模型评测流水线，而不与生产环境争抢资源。

## 延伸阅读 {#further-reading}

内部机制的更多细节请参阅[异步处理器架构](../../../architecture/advanced/batch/async-processor.md)。
