# P/D 分离

LLM 推理包含两个计算特征截然不同的阶段：

* **Prefill** 在一次前向计算中处理整个输入提示词——它是计算密集型的，瓶颈在于可用的 GPU 算力。
* **Decode** 基于 KV 缓存逐个生成输出 token——它是内存带宽密集型的，瓶颈在于数据从 HBM 搬运到片上存储的速度。

对于长上下文工作负载（ISL:OSL 为 10:1）以及中大型模型，把 prefill 和 decode 拆分到不同的实例上可以：

* 通过对 prefill 和 decode 分别专门优化来提升吞吐量
* 提升服务质量，因为长上下文的 prefill 不会阻塞 decode 工作

llm-d 的 EPP 原生支持分离的概念，并可以与其他打分器（例如前缀感知路由）组合使用。

:::info
NIXL 支持 TCP 传输，但在生产环境中**强烈建议**使用高带宽网络（IB、RoCE、EFA）。
:::


## 部署 {#deploy}

清单文件和分步部署说明请参阅 [P/D 分离指南](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/pd-disaggregation)。

## 架构 {#architecture}

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)">
    <img src="/img/versioned/0.10/assets/pd-disaggregation.svg" alt="P/D 分离">
  </picture>
</p>

该部署会创建 2 个 vLLM `Deployment`（它们都属于同一个 `InferencePool`）：

* **prefill** `Deployment` 包含 4 个 TP=1 的 vLLM 副本，标签为 `llm-d.ai/role=prefill`。
* **decode** `Deployment` 包含 1 个 TP=5 的 vLLM 副本，标签为 `llm-d.ai/role=decode`。这些 Pod 都带有一个路由代理 Sidecar。

在标准请求流程中：

* 请求到达代理，代理将请求转发给 EPP
* EPP 以 P/D 分离方式调度请求，通过标签识别 decode 和 prefill 变体
* 请求被路由到 Sidecar，Sidecar 将请求转发给 prefill 实例
* prefill 实例处理提示词，并返回如何获取 KV 块的元数据
* decode 实例通过 NIXL 经 RDMA（IB、RoCE、EFA）拉取 KV
* decode 实例执行 decode

## 可观测性 {#observability}

P/D 分离将 prefill 和 decode 作为独立扩缩的资源池运行，并通过 NIXL KV 传输连接在一起，因此关键信号是各资源池之间的**平衡**和传输的健康状况，而不是单一的聚合延迟。[P/D 指南中的“可观测性与故障排查”一节](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/pd-disaggregation#4-observability--troubleshooting)介绍了这条路径的关键指标和常见故障模式，并以共享的 [PromQL](../../operations/observability/promql.md#prefilldecode-disaggregation) 和[指标](../../operations/observability/metrics.md)参考文档为支撑。

## 延伸阅读 {#further-reading}

更多细节请参阅 [P/D 架构](../../architecture/advanced/disaggregation/README.md)。
