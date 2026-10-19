# 优化基线

传统 HTTP 请求速度快、形态统一、成本低。标准的轮询（round-robin）请求调度策略可以很好地均衡这类负载。

LLM 请求打破了这三个假设。它们是：

* **多轮的**——对话和智能体工具循环会反复发送同一个不断增长的前缀
* **缓慢的**——单个请求生成 token 可能耗时超过一分钟
* **不均匀的**——从数千个推理 token 到 10 万以上的上下文 token 不等

llm-d 路由器把对 LLM 工作负载的感知注入到负载均衡层，同时考虑**前缀缓存亲和性**和**服务器负载指标**。

:::note
本指南演示的是前缀感知与负载感知路由的一种实现方式。llm-d 路由器还支持其他选项，包括会话亲和性和基于活跃请求数的路由，这些方式不要求路由器能够解析请求或探测服务器。有关可用打分器的更多细节请参阅[配置](../../architecture/core/router/epp/configuration.md)，基于 KV 事件的打分请参阅[精确前缀缓存路由](precise-prefix-cache-routing.md)。
:::


## 部署 {#deploy}

清单文件和分步部署说明请参阅[优化基线指南](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/optimized-baseline)。

## 架构 {#architecture}

### 前缀感知调度 {#prefix-aware-scheduling}

EPP 在内存中维护每个端点的前缀缓存状态视图。请求到达时，它会找出哪个 Pod 的 KV 缓存中已经持有匹配的前缀，并把请求路由过去。对于多轮工作负载，在横向扩展的部署中，这项优化对于避免大量重复计算至关重要。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)">
    <img src="/img/versioned/0.10/assets/prefix-aware-routing.svg" alt="前缀感知路由">
  </picture>
</p>

### 负载感知调度 {#load-aware-scheduling}

EPP 以固定间隔（默认 50ms）抓取每个端点的 `/metrics`，持续探测其指标。它根据队列深度、运行中的请求数和 KV 缓存利用率为端点打分，把请求调度到负载最低的端点，避免异构请求模式造成的热点。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)">
    <img src="/img/versioned/0.10/assets/load-aware-routing.svg" alt="负载感知路由">
  </picture>
</p>

## 可观测性 {#observability}

优化基线在两个路由目标之间取得平衡——前缀缓存亲和性与负载感知分散——因此关键信号是缓存命中率和各 Pod 的负载均衡情况，二者需要结合观察。[指南中的“可观测性与故障排查”一节](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/optimized-baseline#4-observability--troubleshooting)介绍了这条路径的关键指标和常见故障模式（包括在非默认硬件上 `peakPrefillThroughput` 的校准陷阱），并以共享的 [PromQL](../../operations/observability/promql.md) 和[指标](../../operations/observability/metrics.md)参考文档为支撑。

## 延伸阅读 {#further-reading}

更多细节请参阅 [EPP 架构](../../architecture/core/router/epp/README.md)。
