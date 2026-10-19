# 工作负载自动扩缩容

传统的自动扩缩容指标（如 CPU/GPU 资源利用率）往往是滞后指标——它们只能在饱和已经发生之后才反映出来，而此时延迟已经飙升，请求可能已经开始失败。对于 LLM 推理，问题更加严重：在活跃批处理期间，无论实际负载如何，GPU 利用率通常都接近 100%，这使它完全不可靠。

有效的 LLM 自动扩缩容需要主动的、SLO 感知的信号，以反映推理系统的真实状态——队列深度、进行中的请求数以及 KV 缓存压力——从而在终端用户延迟受到影响之前增加容量。

llm-d 技术栈为工作负载自动扩缩容提供了两条主要路径。EPP 路径使用由 KEDA 创建和管理的 HPA。WVA 路径发布期望副本数信号，可根据部署配置由 HPA 或 KEDA 消费。

## 部署 {#deploy}

两条路径的清单文件和分步部署说明请参阅[工作负载自动扩缩容指南](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/workload-autoscaling)。

## 策略 {#strategies}

### KEDA + EPP 指标 {#keda--epp-metrics}

这条路径使用端点选择器（EPP）直接发出的信号来配置 KEDA 的 Prometheus 扩缩器。借助队列深度和运行中请求数等指标，KEDA 生成的 HPA 会对排队和活跃请求并发做出响应，并在需求下降时减少副本数。

* **最适合**：部署在同构硬件上，且每个目标模型服务器池都可以通过指标隔离并独立扩缩。
* **信号**：EPP 指标（队列深度、运行中请求数）。
* **组件**：KEDA 和 Prometheus；不需要 Prometheus Adapter。

### Workload Variant Autoscaler（WVA） {#workload-variant-autoscaler-wva}

Workload Variant Autoscaler（WVA）专为在共享的、可能是异构的 GPU 硬件上运行多个模型变体的运维人员设计。它持续监控 KV 缓存利用率、队列深度和性能预算，以确定各变体（例如 A100 与 L4）的最佳副本数。

* **最适合**：需要成本感知容量分配的多变体部署。
* **信号**：KV 缓存利用率、队列深度、能耗/性能预算。
* **组件**：WVA 控制器和 KEDA。WVA 会为任何带有 `llm-d.ai/managed: "true"` 注解的 KEDA `ScaledObject`（或 HPA）发布 `wva_desired_replicas` 指标，由 KEDA 据此驱动扩缩。自 llm-d 0.8.0 起，`VariantAutoscaling` CRD 已弃用。

## 如何选择 {#choosing-a-path}

| 特性 | KEDA + EPP 指标 | Workload Variant Autoscaler（WVA） |
|---|---|---|
| **主要目标** | 基于负载扩缩 | 跨硬件的成本优化扩缩 |
| **异构支持** | 有限 | 原生支持 |
| **复杂度** | 低（需要 KEDA 和 Prometheus） | 中（需要 WVA 控制器） |
| **缩容到零** | 支持 | 支持 |

## 可观测性 {#observability}

自动扩缩容是一个闭环，因此需要把模型服务器、扩缩器以及最终资源池上的信号组合起来观察，而不是只看某一个指标。[指南中的“可观测性与故障排查”一节](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/workload-autoscaling#observability--troubleshooting)端到端地梳理了这一闭环（需求、决策、收敛、结果）以及两条扩缩路径的常见故障模式，并以共享的 [PromQL](../../operations/observability/promql.md) 和[指标](../../operations/observability/metrics.md)参考文档以及 WVA 指标定义为支撑。
