# 架构

llm-d 架构的高层指南。请从这里开始，再深入阅读各专题文档。

## 核心组件 {#core-components}

llm-d 架构围绕三个主要概念构建：[路由器](core/router/README.md)、[InferencePool](core/inferencepool.md) 和[模型服务器](core/model-servers.md)。

- **[llm-d 路由器](core/router/README.md)**——推理请求的智能入口。它提供 LLM 感知的负载均衡、请求排队和策略执行。它由两个功能部分组成：
  - **[代理（Proxy）](core/router/proxy.md)**：一个符合 [Gateway API Inference Extension（GAIE）](https://gateway-api-inference-extension.sigs.k8s.io/concepts/conformance/)规范的高性能 L7 代理，它接收用户请求，并通过 `ext-proc` 协议咨询 EPP 以确定最佳目标。
  - **[端点选择器（EPP）](core/router/epp/README.md)**：路由引擎，基于实时指标、KV 缓存亲和性和配置的策略，为模型服务器 Pod 打分并进行选择。

- **[InferencePool](core/inferencepool.md)**——通过标签选择器把提供同一基础模型的模型服务器 Pod 组织在一起的 API。可以把它理解为“为 LLM 优化的 Service”，它是路由器的发现目标。此外：
  - **变体（Variant）**——InferencePool 内模型服务器 Pod 的逻辑子分组，通过 Pod 标签而非专门的资源来表达。变体根据共同特征区分模型服务器，例如服务角色（如 prefill 或 decode）、成本特征、性能特征（吞吐量、延迟）或其他运维属性。

- **[模型服务器](core/model-servers.md)**——在硬件加速器（GPU、TPU、HPU）上执行模型的推理引擎（例如 vLLM 或 SGLang）。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)">
    <img alt="llm-d 基础架构" src="/img/versioned/0.10/assets/basic-architecture.svg" />
  </picture>
</p>

## 高级模式 {#advanced-patterns}

llm-d 的核心设计可以通过以下可选的高级模式进行扩展：

### KV 缓存管理 {#kv-cache-management}

llm-d 提供了一整套在推理资源池中管理和复用 KV 缓存的生态组件，包括：

- [前缀缓存感知路由](advanced/kv-management/prefix-cache-aware-routing.md)：最大化缓存命中的启发式和精确技术。
- [KV 缓存索引](advanced/kv-management/kv-indexer.md)：基于事件追踪所有模型服务器的缓存状态。
- [KV 卸载](advanced/kv-management/kv-offloader.md)：分层存储体系（CPU、SSD），用于扩展缓存容量。
- [P2P 前缀缓存共享](../well-lit-paths/foundations/enable-p2p-prefix-cache-sharing.md)：从对等节点的 CPU 层拉取已缓存的前缀 KV 块，而不是重新计算。

这些组件如何组合，请参阅 [KV 缓存管理](advanced/kv-management/README.md)概览。

### 分离式服务 {#disaggregated-serving}

在分离式服务中，单个推理请求被拆分为多个阶段（例如 Prefill 和 Decode），由专门的工作节点处理。llm-d 路由器负责编排这一流程：同时选择一个 prefill 端点和一个 decode 端点，并协调它们之间的 KV 缓存传输。

完整细节请参阅[分离](advanced/disaggregation/README.md)。

### 基于预测延迟的路由 {#predicted-latency-based-routing}

llm-d 路由器可以通过“顾问”Sidecar 进行扩展，这些 Sidecar 为路由决策提供高级信号。主要实现是**延迟预测器（Latency Predictor）**，它支持基于预测的 ITL 和 TTFT 进行路由。

- [延迟预测器](advanced/latency-predictor.md)：在线训练 XGBoost 模型来预测请求延迟，以实现更好的端点打分和 SLO 保障。

### 批量推理 {#batch-inference}

批处理和离线推理工作负载由两个模块处理，它们可以独立部署，也可以一起部署。批处理网关（Batch Gateway）提供兼容 OpenAI 的 Batch API 用于作业管理，而异步处理器（Async Processor）在流量控制门控下分发排队的请求。两者组合使用时，批处理网关会把分发工作委托给异步处理器。

批量推理设计的细节请参阅[批量推理](advanced/batch/README.md)。

### 自动扩缩容 {#autoscaling}

llm-d 支持由 EPP 导出的指标驱动的主动式、SLO 感知的自动扩缩容。KEDA 的 Prometheus 扩缩器读取这些信号——队列深度、资源池饱和度、token 积压量或相对 SLO 的预估延迟——并创建和管理用于扩缩模型服务器副本的 HPA。不需要自定义控制器或 Prometheus Adapter。

Workload Variant Autoscaler（WVA）曾用于在各变体和推理资源池之间全局优化副本放置，现已弃用。

完整细节请参阅[自动扩缩容](advanced/autoscaling/README.md)。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)">
    <img alt="llm-d 高级架构" src="/img/versioned/0.10/assets/images/llm-d-arch.svg" />
  </picture>
</p>
