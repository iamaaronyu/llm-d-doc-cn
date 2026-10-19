# 自动扩缩容

借助自动扩缩容，模型服务器会被自动增加或移除，使服务容量与推理需求保持一致。llm-d 依据端点选择器（EPP）发出的信号进行扩缩——排队请求数、活跃并发、token 积压量或相对 SLO 的预估延迟——因为加速器利用率并不能可靠地反映 LLM 负载：在活跃批处理期间，无论服务器是轻载还是饱和，GPU 利用率都可能接近 100%。

## KEDA + EPP 指标（推荐） {#keda--epp-metrics-recommended}

KEDA 的 Prometheus 扩缩器读取 EPP 指标，把它们计算为扩缩器的取值，并创建和管理用于扩缩模型服务器副本的 HPA。整个回路中没有自定义控制器，也没有 Prometheus Adapter。

关于流水线、指标隔离规则、所有权语义、缩容到零以及局限性，请参阅[结合 EPP 指标的 KEDA](./keda-epp.md)。

有四种信号共用这条流水线，每种都有各自可部署的指南：

| 信号 | 扩缩依据 | 指南 |
|---|---|---|
| **队列深度** | 每个副本排队请求数和运行中请求数的绝对目标值 | [keda-epp-queue](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/workload-autoscaling/keda-epp-queue) |
| **资源池饱和度** | 归一化的饱和度比率（0.0–1.0+），在不同硬件间更具可移植性 | [keda-epp-saturation](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/workload-autoscaling/keda-epp-saturation) |
| **Token 积压** | prefill 队列等待的秒数加上 KV 缓存占用——适用于提示词长度差异很大的场景 | [keda-epp-token-aware](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/workload-autoscaling/keda-epp-token-aware) |
| **预估延迟** | 预测（或实测）的 TTFT/TPOT 相对于延迟 SLO 的情况 | [slo-aware](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/workload-autoscaling/slo-aware) |

由延迟驱动的这种变体值得单独阅读：它把各个触发器合并为一个公式，公式的输出就是期望的副本数。推导过程请参阅[基于 KEDA 的 SLO 感知自动扩缩容——控制律](./slo-aware-keda.md)，可部署的配置请参阅 [SLO 感知自动扩缩容指南](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/workload-autoscaling/slo-aware)。

## Workload Variant Autoscaler（已弃用） {#workload-variant-autoscaler-deprecated}

:::warning
WVA 已弃用。新部署请使用 KEDA + EPP。
:::


WVA 曾是一个全局优化器和控制器：给定一份可用加速器清单，它决定如何把模型服务器放置到这些加速器上——这些模型服务器可能提供不同的基础模型、运行在异构硬件上、并承担分离式 prefill/decode 角色——并发布 `wva_desired_replicas` 指标供 HPA 消费。它会计算各变体的成本、在稀缺加速器上进行公平分配，并把待调度的 Pod 纳入决策。

保留的设计参考请参阅 [Workload Variant Autoscaler（WVA）](./wva.md)，迁移到 KEDA + EPP 请参阅[从 WVA 迁移](./wva.md#migrating-off-wva)。

## 弃用带来的变化 {#what-changed-with-the-deprecation}

KEDA + EPP 并没有逐项替代 WVA 的所有功能。跨变体的成本感知放置目前没有对应的替代方案；其余功能都已覆盖，只是有时由自动扩缩器之外的另一层来实现：

| 能力 | WVA（已弃用） | KEDA + EPP |
|---|---|---|
| **同一模型的多个变体** | 跨模型和拓扑进行最优放置以最小化成本 | 每个 Deployment 独立扩缩；变体之间没有成本感知的偏好 |
| **加速器有限** | 跨资源池的公平份额分配 | 由自动扩缩器之下的 [Kueue](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/workload-autoscaling/kueue-rebalancing) 处理——在共享 cohort 中为每个模型设置配额下限，并支持借用和抢占 |
| **感知待调度 Pod** | 把待调度（未被调度）的 Pod 纳入决策 | 可用——触发器可以从 kube-state-metrics 读取副本数；[slo-aware](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/workload-autoscaling/slo-aware) 路径会按 `readyReplicas/replicas` 折减其扩容需求 |
| **严格的延迟 SLO** | 学习供需动态（实验性） | 直接依据预估延迟相对 SLO 的情况扩缩（[slo-aware](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/workload-autoscaling/slo-aware)） |
| **缩容到零** | 支持 | 支持（KEDA，无需 `HPAScaleToZero` 特性开关） |
| **运维复杂度** | 中——需要 WVA 控制器（以及指标适配器） | 低——KEDA 和 Prometheus |

如果某个部署依赖跨变体的成本感知放置，或依赖对稀缺加速器池的公平共享，请暂时继续使用 WVA，并关注[工作负载自动扩缩容指南](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/workload-autoscaling)以获取替代方案。
