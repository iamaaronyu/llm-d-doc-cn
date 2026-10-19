# 核心能力构件

核心能力构件代表 llm-d 的各项单独功能：功能优化、智能路由和具体的推理执行特性。

这些指南讲解单项架构能力，你可以单独配置它们，也可以把它们组合成完整的生产级工作负载。

### 智能路由 {#intelligent-routing}

- **[优化基线](optimized-baseline.md)**：应对 LLM 请求调度独特挑战的策略，超越传统的轮询（round-robin）方式。
- **[基于预测延迟的路由](predicted-latency.md)**：使用在线训练的机器学习模型预测延迟并优化调度。
- **[多模型路由](multi-model-routing.md)**：借助推理载荷处理器（IPP），在单个 Gateway 端点后提供多个 LLM 和 LoRA 适配器。

### 高级 KV 缓存管理 {#advanced-kv-cache-management}

- **[精确前缀缓存路由](precise-prefix-cache-routing.md)**：基于模型服务器发布的精确缓存状态进行近实时路由。
- **[分层前缀缓存](tiered-prefix-cache.md)**：将 KV 缓存卸载到 CPU 内存、NVMe 或网络存储，高效管理 KV 缓存，提高前缀缓存的复用率。
- **[启用 P2P 前缀缓存共享](enable-p2p-prefix-cache-sharing.md)**：直接从对等节点的 CPU 卸载层拉取已缓存的前缀 KV 块，而不是重新计算，把每个 Pod 各自的前缀缓存变成整个集群共享的资源。

### 部署大模型 {#serving-large-models}

- **[Prefill/Decode 分离](pd-disaggregation.md)**：将 prefill（计算密集型）与 decode（内存带宽密集型）阶段分开，以优化性能。
- **[宽专家并行](wide-expert-parallelism.md)**：使用 DP/EP 部署模式，为 DeepSeek-R1 等超大 MoE 模型扩展 KV 缓存空间。

### 流量控制与自动扩缩容 {#traffic-control--autoscaling}

- **[流量控制](flow-control.md)**：面向多租户部署的智能请求排队，以及流量突增的管理。
- **[工作负载自动扩缩容](workload-autoscaling.md)**：从结合 EPP 负载指标的简单 Kubernetes 自动扩缩容，到借助 Workload Variant Autoscaler 为异构资源池实现的高级 SLO 感知容量优化。
- **[快速模型启动](fast-model-actuation.md)**：通过常驻的休眠/唤醒实例和预热的启动器（无需重新导入模块即可派生新实例）缩短 vLLM 启动时间，使副本扩容和模型切换在共享 GPU 池上避开冷启动开销。
