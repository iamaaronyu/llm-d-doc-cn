# 术语表

llm-d 文档中常用术语的速查定义。关于这些组件如何协同工作的整体介绍，请参阅[架构概览](../architecture/README.md)。

---

**聚合式服务（Aggregated Serving）** — 默认的服务模式：由单个模型服务器同时处理每个请求的预填充（Prefill）和解码（Decode），与分离式服务相对。

**顾问组件（Consultant）** — 可选的 Sidecar 组件，EPP 会向其查询内置指标之外的额外打分信号。例如[延迟预测器](../architecture/advanced/latency-predictor.md)和 [KV 缓存索引器](../architecture/advanced/kv-management/kv-indexer.md)。

**数据并行（Data Parallelism，DP）** — 在同一节点的不同 GPU 上运行相互独立的模型副本，各自处理不同的请求，以提高总吞吐量。参见[模型服务器](../architecture/core/model-servers.md)。

**解码（Decode）** — LLM 推理的第二阶段，逐个生成输出 token，每个 token 都依赖前一个 token 的 KV 缓存状态。解码吞吐量用 TPOT 衡量。参见[架构概览](../architecture/README.md)。

**分离式服务（Disaggregated Serving）** — 一种部署模式，将预填充和解码拆分到各自专用、可独立扩缩的模型服务器资源池中，两者之间通过 NIXL 传输 KV 缓存。参见[P/D 分离](../architecture/advanced/disaggregation/README.md)。

**Envoy** — 高性能、符合 GAIE 规范的 L7 代理，可作为 llm-d 的数据平面代理使用。它通过 ext-proc 与 EPP 交互路由决策。参见[代理](../architecture/core/router/proxy.md)。

**专家并行（Expert Parallelism，EP）** — 将 MoE 模型的专家层分布到多块 GPU 上，使 DeepSeek-R1 这类大模型能够跨节点提供服务。参见[模型服务器](../architecture/core/model-servers.md)。

**ext-proc（外部处理，External Processing）** — 一种 Envoy 过滤器协议，把每个请求的路由决策卸载给外部 gRPC 服务——在 llm-d 中即 EPP。它是代理与路由逻辑之间的通信通道。参见 [EPP](../architecture/core/router/epp/README.md)。

**流量控制（Flow Control）** — EPP 的子系统，通过“优先级—公平性—排序”层级管理请求的准入、排队和分发，防止后端过载。参见 [EPP](../architecture/core/router/epp/README.md)。

**Gateway API** — Kubernetes 原生的 L7 流量路由配置 API，是 Ingress 的继任者。llm-d 使用 Gateway API 资源（`HTTPRoute`、`Gateway`）把外部流量路由到 InferencePool。参见[代理](../architecture/core/router/proxy.md)。

**Gateway API Inference Extension（GAIE）** — Gateway API 的扩展，通过 ext-proc 增加推理感知的路由能力，并定义了 InferencePool CRD。参见[代理](../architecture/core/router/proxy.md)。

**InferencePool** — 由 Gateway API Inference Extension 定义的 Kubernetes 自定义资源，表示 EPP 在路由请求时所考虑的模型服务器 Pod 集合。参见 [InferencePool](../architecture/core/inferencepool.md)。

**KV 缓存（KV Cache）** — 在 LLM 推理过程中存储注意力中间状态的键值张量缓存。为共享的提示词前缀复用已缓存的条目（前缀缓存），可避免重复计算并降低延迟。参见[架构概览](../architecture/README.md)。

**KV 缓存索引器（KV-Cache Indexer）** — 一种顾问组件，利用 KV 事件维护 KV 缓存块在各模型服务器间分布情况的全局一致视图，从而实现精确的前缀缓存感知路由。参见 [KV 缓存索引器](../architecture/advanced/kv-management/kv-indexer.md)。

**KV 事件（KV-Events）** — 模型服务器在创建或驱逐 KV 缓存块时（通过 ZeroMQ）发出的事件，由 KV 缓存索引器消费，用于实时跟踪缓存状态。

**延迟预测器（Latency Predictor）** — 一种顾问组件，使用基于实时流量训练的 XGBoost 分位数回归模型来预测每个端点的 TTFT 和 TPOT，从而实现 SLO 感知路由。参见[延迟预测器](../architecture/advanced/latency-predictor.md)。

**llm-d** — 一个分布式推理服务栈，在现有模型服务器之上增加智能路由、KV 缓存感知路由、分离式服务和自动扩缩容能力。参见[简介](../getting-started/README.mdx)。

**llm-d 异步处理器（llm-d Async Processor）** — 轻量级分发代理，从消息队列（如 Redis 和 Google Pub/Sub）中逐条拉取推理请求并发送给 llm-d 路由器。它会根据系统指标调整分发速率，以保护交互式流量。参见[批量推理](../architecture/advanced/batch/README.md)。

**llm-d 批处理网关（llm-d Batch Gateway）** — 兼容 OpenAI 的 API 服务器（`/v1/batches`、`/v1/files`），用于提交、跟踪和管理批量推理作业。它与 llm-d 异步处理器协同，实现限速的请求分发。参见[批量推理](../architecture/advanced/batch/README.md)。

**llm-d 端点选择器（llm-d Endpoint Picker，EPP）** — llm-d 的核心路由组件。它接收来自代理的 ext-proc 回调，通过由过滤器、打分器和选择器组成的插件流水线评估候选模型服务器，并返回最优后端的地址。参见 [EPP](../architecture/core/router/epp/README.md)。

**llm-d 路由器（llm-d Router）** — 推理请求的智能入口。它提供 LLM 感知的负载均衡（例如前缀缓存感知和负载感知路由）以及请求排队，并管理分离式服务。它由两个功能部分组成：数据平面**代理**（例如 Envoy）和**端点选择器（EPP）**。参见[架构概览](../architecture/README.md)。

**llm-d 成熟路径（llm-d Well-Lit Path）** — 经过预先验证的端到端部署方案（模型 + 硬件 + Helm values + 基准测试），由 llm-d 社区作为一等配置进行测试和支持。参见[简介](../getting-started/README.mdx)。

**MoE（混合专家，Mixture of Experts）** — 一种模型架构，每个 token 只激活一部分“专家”子网络，使超大模型（例如 DeepSeek-R1）能够高效运行。llm-d 通过宽专家并行支持 MoE 服务。

**模型服务器（Model Server）** — 推理引擎（例如 vLLM、SGLang），负责加载模型权重、在硬件加速器上执行推理并管理本地 KV 缓存。EPP 把请求路由到最优的服务器实例。参见[模型服务器](../architecture/core/model-servers.md)。

**NIXL** — NVIDIA Inference Xfer Library，用于通过 InfiniBand、RoCE、EFA 和 TCP 在 GPU 之间高速传输 KV 缓存。在分离式服务中用于预填充与解码工作节点之间。

**插件流水线（Plugin Pipeline）** — EPP 内部模块化的“过滤—打分—选择”架构，为每个请求评估并选出模型服务器端点。过滤器缩小候选范围，打分器对候选排序，选择器做出最终选择。参见 [EPP](../architecture/core/router/epp/README.md)。

**前缀缓存（Prefix Caching）** — 一种技术：EPP 把请求路由到已持有该提示词前缀对应 KV 缓存条目的模型服务器，从而消除重复的预填充计算并降低 TTFT。参见[架构概览](../architecture/README.md)。

**预填充（Prefill）** — LLM 推理的第一阶段，并行处理所有输入 token 以填充 KV 缓存。预填充延迟是 TTFT 的主要组成部分。参见[架构概览](../architecture/README.md)。

**代理（Proxy）** — L7 数据平面组件，接收客户端请求，并通过 ext-proc 把路由决策委托给 EPP。可以通过 Gateway API 部署，也可以在独立模式下部署——此时由符合 GAIE 规范的代理（如 Envoy）作为 EPP 的 Sidecar 运行。参见[代理](../architecture/core/router/proxy.md)。

**饱和检测器（Saturation Detector）** — EPP 中的安全机制，根据队列深度和 KV 缓存利用率判断后端 InferencePool 是否过载，进而触发流量控制或请求削减。

**SGLang** — 开源 LLM 服务引擎，可作为 llm-d 的模型服务器后端，提供基于 RadixAttention 的前缀缓存和分离式服务支持。参见[模型服务器](../architecture/core/model-servers.md)。

**张量并行（Tensor Parallelism，TP）** — 在节点内把模型层切分到多块 GPU 上，以服务超出单卡显存的模型。参见[模型服务器](../architecture/core/model-servers.md)。

**KV 缓存管理（KV Cache Management）** — 一套用于在推理资源池内管理和复用 KV 缓存的完整生态，包括**前缀缓存感知路由**、**KV 缓存索引**和 **KV 卸载**，可将有效缓存容量扩展到硬件限制之外。参见 [KV 缓存管理](../architecture/advanced/kv-management/README.md)。

**TPOT（每输出 token 时间，Time Per Output Token）** — 解码阶段生成每个后续 token 的平均延迟，是衡量流式响应质量的关键指标。参见[架构概览](../architecture/README.md)。

**TTFT（首 token 时间，Time To First Token）** — 从请求到达到生成第一个输出 token 的延迟，主要由预填充时间决定。前缀缓存是降低 TTFT 的主要优化手段。参见[架构概览](../architecture/README.md)。

**vLLM** — 开源的高吞吐 LLM 服务引擎，也是 llm-d 的默认模型服务器。提供 PagedAttention、连续批处理、前缀缓存，以及用于缓存感知路由的 KV 事件。参见[模型服务器](../architecture/core/model-servers.md)。

**宽专家并行（Wide Expert Parallelism）** — 面向大型 MoE 模型的部署模式，跨多个节点组合数据并行与专家并行，最大化可用于长上下文服务的 KV 缓存空间。参见[简介](../getting-started/README.mdx)。

**工作负载变体自动扩缩器（Workload Variant Autoscaler，WVA）** — 一个多模型、SLO 感知的自动扩缩器，通过测量实例容量、推导负载函数并计算模型变体的最优组合，在异构硬件上优化成本。参见[架构概览](../architecture/README.md)。
