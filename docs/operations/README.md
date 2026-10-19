# 卓越运维

卓越运维指南聚焦于生成式 AI 推理部署的整体 Day-2 站点可靠性工程（SRE）、集群范围的遥测框架，以及安全的生命周期发布策略。

[成熟路径指南](../well-lit-paths/README.md)讲解如何配置 llm-d 原生的智能路由算法和推理优化，而本节则关注企业级集群的可观测性、告警以及零停机的模型更新。

### [集群可观测性](observability/README.md) {#cluster-observability}

端到端的遥测配置、OpenTelemetry 链路追踪、标准 Prometheus 指标、PromQL 仪表盘以及监控架构。

### [分离式服务运维](disaggregation/README.md) {#disaggregated-serving-operations}

动态连接、请求取消、容错和安全发布方面的运维考量，以及针对各引擎（vLLM 和 SGLang）的指南。

### [零停机发布](rollouts/README.md) {#zero-downtime-rollouts}

生产环境的发布策略，包括蓝绿更新以及在不中断活跃客户端流量的情况下热替换 LoRA 适配器。

### [模型感知的就绪探针](readiness-probes.md) {#model-aware-readiness-probes}

使用 vLLM API 端点配置 Kubernetes HTTP 探针，确保只有在模型完全加载后 Pod 才被标记为 Ready。

### [优雅关闭与请求排空](graceful-shutdown.md) {#graceful-shutdown--request-draining}

在缩容、滚动更新和节点排空期间排空进行中的请求（适用于一般服务场景）：Kubernetes 的终止流程、vLLM 的 `--shutdown-timeout`、客户端断开时的请求取消，以及 EPP 流量控制的排空语义。

### [对接外部 API](serve-external-apis/README.md) {#serve-external-apis}

部署 LiteLLM Proxy 或 Kong AI Gateway，在自托管的 llm-d 推理技术栈与外部云服务商的 LLM API 之间无缝路由流量。

### [路由器运维](router.md) {#router-operations}

llm-d 路由器部署的运维最佳实践、高可用扩缩模式、独立代理架构以及容器资源规划。

### [异步处理器运维](async-processor.md) {#async-processor-operations}

异步处理器批量分发代理的吞吐建模、并发规模规划（基于实测的参数扫描）、容器资源规划以及水平扩展。

### [模型加载与启动加速](model-loading-and-startup.md) {#model-loading-and-startup-acceleration}

llm-d 部署的模型来源、持久化缓存以及启动优化选项。
