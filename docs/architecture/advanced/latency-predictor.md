# 延迟预测器

延迟预测器是 llm-d 中支撑基于预测延迟进行调度的组件。EPP 不再仅凭粗粒度的利用率信号为 Pod 打分，而是请求一个在线训练的机器学习模型，为每个候选 Pod 预测**首 token 时间（TTFT）**和**每输出 token 时间（TPOT）**，然后依据这些预测进行路由——还可以选择按每个请求的服务等级目标（SLO）进行门控。

本页是该组件的参考文档：涵盖其设计、EPP 插件、机器学习模型、故障模式和扩展特性。关于分步采用——Helm 启用、SLO 请求头用法、验证和故障排查——请参阅[预测延迟成熟路径](../../well-lit-paths/foundations/predicted-latency.md)。设计思路和基准测试见博客文章 [LLM 的基于预测延迟调度](https://llm-d.ai/blog/predicted-latency-based-scheduling-for-llms)。

## 为什么要预测延迟？ {#why-predicted-latency}

基于利用率的负载均衡在 LLM 工作负载上存在结构性缺陷：

- **请求成本差异巨大。**10 个 token 的提示词和 10,000 个 token 的提示词都算作一个排队请求，但它们的 prefill 和 decode 成本相差几个数量级。
- **缓存复用不稳定。**前缀命中率会随流量模式变化，因此缓存亲和性与利用率之间的静态权重会逐渐失调。
- **目标相互冲突。**优化 TPOT 倾向于分散负载；优化 TTFT 和缓存复用则倾向于集中负载。没有一种固定的权重配置在所有情况下都正确。
- **缺乏 SLO 感知。**利用率打分器无法回答“这个 Pod 能否在调用方的延迟预算内处理这个请求？”

延迟预测器通过直接从线上流量中学习 `(Pod 状态, 请求特征) → 延迟` 的映射，并让 EPP 基于相对 SLO 的余量进行推理（而不是依赖手工调整的权重），弥补了这些缺陷。

## 架构 {#architecture}

预测器以一组 Sidecar 的形式与 EPP 部署在同一个 Pod 中。一个**训练服务器**持续使用已完成的请求重新训练模型；一个或多个**预测服务器**从共享卷读取最新模型，并在关键路径上响应 EPP 的预测请求。

```
                ┌──────────────────────────────────────────────────────┐
                │                      EPP Pod                         │
                │                                                      │
                │  ┌─────────────┐        ┌──────────────────────────┐ │
                │  │             │        │   训练服务器             │ │
   推理请求 ───►│  │     EPP     │───────►│                          │ │
                │  │             │  样本  │   收集已完成的请求，     │ │
                │  │ 基于延迟的  │        │   重新训练 XGBoost 模型  │ │
                │  │   插件      │        └────────────┬─────────────┘ │
                │  │             │                     │ 写入          │
                │  │             │                     ▼ 模型          │
                │  │             │        ┌──────────────────────────┐ │
                │  │             │        │   共享卷                 │ │
                │  │             │        └────────────┬─────────────┘ │
                │  │             │                     │ 读取          │
                │  │             │                     ▼ 模型          │
                │  │             │        ┌──────────────────────────┐ │
                │  │             │───────►│   预测服务器             │ │
                │  │             │  预测  │   （可水平扩展）         │ │
                │  │             │◄───────│                          │ │
                │  │             │  结果  │   提供 TTFT/TPOT 预测    │ │
                │  │             │        │                          │ │
                │  └─────────────┘        └──────────────────────────┘ │
                └──────────────────────────────────────────────────────┘
```

在 EPP 中，基于延迟的调度由一系列可组合的 EPP 插件实现（后文详述）。`predicted-latency-producer` 插件负责与预测器交互。对于每个请求，它调用预测器，基于端点的状态（KV 缓存利用率、队列深度、前缀缓存匹配得分）为每个候选端点获取 TTFT 和 TPOT 预测。请求处理完成后，生产者把观测到的 TTFT 和 ITL 延迟作为训练样本发回预测器，从而让模型基于线上流量持续重新训练。

如果预测服务器不可达或无法返回预测，延迟打分器会回退到由 KV 缓存利用率、队列深度和前缀缓存匹配构建的综合分数——因此预测器故障只会退化为基线启发式路由，而不会丢弃流量。

### 机器学习模型 {#ml-model}

预测模型是实时训练的 **XGBoost** 回归模型。系统维护两个模型——一个用于 TTFT，一个用于 TPOT——并基于已完成请求的滑动窗口重新训练。

训练使用**分层分桶**——样本按 KV 缓存利用率（以 10% 为步长）、前缀缓存命中率（以 0.25 为步长）等特征划分。每个桶有自己的样本上限，因此在当前窗口中罕见的流量状态（例如低负载时冷的前缀缓存）不会被模型遗忘。在各轮基准测试中，两个目标上的模型都达到了约 **5% 的平均绝对百分比误差（MAPE）**。

预测器假定**推理资源池是同构的**——资源池中的每个 Pod 必须使用相同的 GPU 类型、模型权重和服务配置。模型训练所用的特征描述的是 Pod 状态（KV 缓存利用率、队列深度、运行中请求数、前缀命中率），而没有编码 Pod 形态，因此跨异构硬件或服务配置的预测会把模型视为相同的不同状态混为一谈。目前尚未对异构资源池建模。

**TTFT 特征**

| 特征 | 反映的内容 |
|---------|------------------|
| KV 缓存使用率 % | 内存饱和度及其对 prefill 调度的影响 |
| 输入长度 | prefill 成本的代理指标——较长的提示词主导 TTFT |
| 队列深度 | 调度前的积压——等待的请求越多，首 token 越晚 |
| 运行中请求数 | GPU 并发度——与进行中 decode 的争用 |
| 前缀缓存匹配 % | KV 复用潜力——高匹配率会大幅减少 prefill 工作量 |
| 进行中的输入 token 数 | 已分发但尚未 prefill 的 token，加上仍驻留在 KV 中的 token——反映即将到来的 prefill 压力 |

**TPOT 特征**

| 特征 | 反映的内容 |
|---------|------------------|
| KV 缓存使用率 % | decode 期间的内存压力 |
| 输入长度 | 输入 token 数（影响注意力计算成本） |
| 队列深度 | 渗透到 decode 组批中的队列争用 |
| 运行中请求数 | 活跃 decode 批大小 / GPU 并发度 |
| 已生成 token 数 | 到目前为止已生成的输出 token |

### 可扩展性 {#scalability}

在一个 `c4-standard-192` 节点（约 192 个 vCPU）上，每个预测 Sidecar 大约能承受 300 QPS 的预测工作量。由于 EPP 会为每个候选 Pod 做一次预测，总预测负载按 `集群 QPS × Pod 数量` 增长。可以通过增加预测 Sidecar 并更新预测器 URL 列表来水平扩展。

| 集群 QPS | 平均预测延迟（ms） | p99 预测延迟（ms） | 预测服务器数 |
|-------------|------------------------------|------------------------------|---------------------|
| 100         | 3.5                          | 46                           | 1                   |
| 1,000       | 5.0                          | 49                           | 2                   |
| 5,000       | ~27                          | ~74                          | 2                   |
| 7,500       | ~35                          | ~96                          | 3                   |
| 10,000      | ~48                          | ~137                         | 4                   |

### 流式模式 {#streaming-mode}

`predicted-latency-producer` 插件有两种训练模式，通过 `streamingMode` 参数控制：

- **`streamingMode: false`**（默认）——基于端到端请求延迟训练。TTFT 在响应完成时记录（实际上是端到端延迟）；不训练 TPOT。**如果**你的工作负载混合了流式和非流式响应，或者只需要延迟感知路由而不需要按请求执行 SLO，**请使用此模式**。
- **`streamingMode: true`**——分别训练 TTFT 和 TPOT 模型。TTFT 在第一个流式分块到达时记录；TPOT 在后续 token 中采样。**如果**你的工作负载完全是流式的，并且需要有意义地执行 `x-llm-d-slo-ttft-ms` / `x-llm-d-slo-tpot-ms`，**请使用此模式**——在此模式下运行混合工作负载，会对非流式响应产生错误的测量结果。

## 调度策略 {#scheduling-strategy}

如前所述，基于延迟的调度在 EPP 中由一组可组合的插件实现。利用 `predicted-latency-producer` 插件获得的延迟预测，调度通过一系列过滤和打分插件来确定最优放置。通过 Helm Chart 启用延迟预测器时，整个序列会被自动连线。当请求不包含 SLO 请求头时，SLO 专用插件不起作用，因此同一组插件可以同时处理带 SLO 标注和不带 SLO 标注的流量。

### 过滤策略 {#filtering-strategy}

在打分之前，有两个过滤器缩小候选集。

- **[`prefix-cache-affinity-filter`](https://github.com/llm-d/llm-d-router/tree/v0.11.0/pkg/epp/framework/plugins/scheduling/filter/prefixcacheaffinity/README.md)**：当任一端点的前缀缓存匹配得分超过亲和阈值（默认 `0.80`）时，把候选集缩小到缓存热的端点。如果没有端点超过阈值，该过滤器不起作用。它在缓存局部性上实现了 epsilon-greedy 的利用/探索策略，并带有基于 TTFT 的“逃生舱”：

  - **利用**（默认路径）。过滤器把候选范围缩小到缓存热的端点，使下游打分把复用集中在这些端点上。
  - **探索**（小概率）。对一定比例（可配置）的请求，过滤器会完全跳过自身，让流量落到缓存冷的 Pod 上，以便它们生成新的缓存条目——这可以防止某个 Pod 永久独占一个热门前缀。
  - **TTFT 负载闸门**。即使在利用路径上，如果最佳缓存热 Pod 的预测 TTFT 明显差于全局最佳 Pod（差距超过可配置的惩罚值），过滤器也会打破亲和性并返回完整的候选集。这避免了热门前缀在饱和的 Pod 后面越堆越多、而较空闲的 Pod 却闲置的情况。

- **[`slo-headroom-tier-filter`](https://github.com/llm-d/llm-d-router/tree/v0.11.0/pkg/epp/framework/plugins/scheduling/filter/sloheadroomtier/README.md)**：把端点划分为**正向**档（预测满足 SLO）和**负向**档（预测违反 SLO），并以一定概率探索负向档，使正在恢复的 Pod 仍能获得流量。没有 SLO 请求头时不起作用。

### 打分策略 {#scoring-strategy}

由三个插件负责打分和最终选择。

- **[`latency-scorer`](https://github.com/llm-d/llm-d-router/tree/v0.11.0/pkg/epp/framework/plugins/scheduling/scorer/latency/README.md)**：为端点打分。没有 SLO 请求头时，预测延迟最低者胜出。有 SLO 请求头时，分数根据余量（`SLO − 预测值`）并通过 `headroomSelectionStrategy` 参数得出：

  - **`least`**（默认）。装箱策略：优先选择最接近 SLO 边界的端点——如果有 Pod 能满足 SLO，选正余量最小的；否则选负缺口最小的。最大化利用率，并为突发流量保留较空闲的 Pod。
  - **`most`**。分散策略：优先选择正余量最大的端点。更保守，为意外的流量尖峰留出余地。对于负余量，无论此设置如何，始终使用 `least`。

- **[`latency-slo-admitter`](https://github.com/llm-d/llm-d-router/blob/v0.11.0/pkg/epp/framework/plugins/requestcontrol/admitter/latencyslo/README.md)**：当没有任何端点能满足 SLO 时，拒绝*可丢弃*的请求（priority < 0），而不是把容量浪费在注定无法满足的请求上。没有 SLO 请求头时不起作用。

- **[`weighted-random-picker`](https://github.com/llm-d/llm-d-router/tree/v0.11.0/pkg/epp/framework/plugins/scheduling/picker/weightedrandom/README.md)**：以分数为权重进行加权随机选择。这样既能分散负载，又仍然偏向得分更高的端点，并避免了纯 arg-max 选择中“所有请求都涌向当前最佳 Pod”的故障模式。

## 可观测性 {#observability}

启用延迟预测器后，EPP 会暴露 Prometheus 指标，用于对比实际延迟与预测延迟、统计预测耗时并跟踪 SLO 违约。主要指标如下：

| 指标 | 说明 |
|--------|-------------|
| `llm_d_epp_request_ttft_seconds` | 实际 TTFT 分布。 |
| `llm_d_epp_request_predicted_ttft_seconds` | 预测 TTFT 分布。 |
| `llm_d_epp_request_ttft_prediction_duration_seconds` | 生成 TTFT 预测所花的时间。 |
| `llm_d_epp_request_streaming_tpot_seconds` | 实际 TPOT 分布（流式）。 |
| `llm_d_epp_request_predicted_tpot_seconds` | 预测 TPOT 分布。 |
| `llm_d_epp_request_tpot_prediction_duration_seconds` | 生成 TPOT 预测所花的时间。 |
| `llm_d_epp_request_slo_violation_total` | SLO 违约计数器（标签为 `type="ttft"` 或 `type="tpot"`）。 |
| `llm_d_epp_inference_request_metric` | 请求指标的汇总 Gauge，包括 TTFT、TPOT、SLO 和预测耗时。 |

所有延迟和预测耗时指标都是 Prometheus **直方图（histogram）**，因此仪表盘应通过 `histogram_quantile` 查询它们（计数器则通过 `rate` 查询），而不是读取瞬时值。把实际值与预测值配对对比，运维人员可以在线验证预测器的准确性；SLO 违约计数器是针对 SLO 违约进行告警的主要信号。

## 源码 {#source}

- **EPP 插件**（`predicted-latency-producer`、`prefix-cache-affinity-filter`、`latency-scorer`、`weighted-random-picker`、`slo-headroom-tier-filter`、`latency-slo-admitter`）位于 [llm-d 路由器](https://github.com/llm-d/llm-d-router)仓库。每个插件的配置参考与插件本身放在该仓库中的同一位置。
- **训练和预测服务器代码**（Python 机器学习 Sidecar、XGBoost 模型、分层采样器）位于 [llm-d/llm-d-latency-predictor](https://github.com/llm-d/llm-d-latency-predictor)。

## 延伸阅读 {#further-reading}

- [预测延迟成熟路径](../../well-lit-paths/foundations/predicted-latency.md)——如何采用这条路径：Helm 启用、请求头、验证、故障排查。
- [LLM 的基于预测延迟调度](https://llm-d.ai/blog/predicted-latency-based-scheduling-for-llms)——设计思路和基准测试结果。
- [EPP 调度](../core/router/epp/scheduling.md)——这些插件如何融入 EPP 的请求处理。
