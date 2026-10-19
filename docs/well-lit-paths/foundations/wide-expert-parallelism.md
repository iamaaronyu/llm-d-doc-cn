# 多节点宽专家并行

像 DeepSeek-R1 这样的超大 MoE 模型，仅存放模型权重就可能占用 500GB 以上的显存，挤压了长上下文和高吞吐服务所需的 KV 缓存空间。对于使用 MLA 注意力的模型，这一问题尤为突出，因为在使用张量并行切分时，KV 缓存会被复制。

为解决这些问题，模型服务器支持 DP/EP 部署：注意力层采用数据并行，MLP 层采用专家并行。这种部署模式可以扩展 KV 缓存空间，因为它：

* **可扩展到多节点**——由于集合通信操作（dispatch/combine）是稀疏的（token 在路由后只会发送到对应的专家 rank），其带宽消耗远小于 TP 配置中使用的 all-reduce，因而适合运行在较慢的互联上（IB、RoCE，而非 NVLink）
* **避免 KV 复制**——由于注意力是数据并行的（每个 DP 组中 TP=1），每个 token 的 KV 只有一份副本

下图展示了 vLLM 中 DP/EP 部署的一次前向计算：

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)">
    <img src="/img/versioned/0.10/assets/dp-ep-deployment.svg" alt="DP/EP 部署">
  </picture>
</p>

具体步骤如下：

* 每个 rank 独立运行注意力计算
* MoE 路由器为每个 token 选择 `topk` 个专家（这是稀疏的——以 DeepSeek 为例，会从 256 个专家中选出 8 个）
* token 被“分发”（dispatch，使用 `topk_id`）到对应的专家 rank（例如 rank 1 上的绿色 token 被路由到 E1 和 E3）
* 每个专家独立运行
* token 被“合并”（combine）回原来的注意力 rank

:::info
dispatch/combine 使用基于 NVSHMEM 的 **DeepEP** 后端，并采用 GPU 发起的 RDMA（`ibgda` 传输），要求 InfiniBand/RoCE 全互联。
:::


## 部署 {#deploy}

清单文件和分步部署说明请参阅[宽专家并行指南](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/wide-ep)。模型服务器以 [`DisaggregatedSet`](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/wide-ep#2-deploy-the-model-server) 的形式部署，它把 prefill 和 decode 角色作为一个带版本的整体单元进行管理。

## 架构 {#architecture}

多节点“WideEP”部署通常会与分离式服务结合使用，原因是：

* 分离可以避免出现 Rank N 在计算 prefill、而 Rank M 在计算 decode 时产生的“气泡”
* 可以分别为 prefill 和 decode 使用专门的内核（例如 DeepEP HT 与 DeepEP LL）

因此，我们在部署中采用如下设计：

* 通过 llm-d 的 EPP 实现 prefill 与 decode 分离
* 使用 `LeaderWorkerSet` 管理 vLLM 的多节点 Pod 组部署
* 在 vLLM 中使用 DP/EP 部署配置

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)">
    <img src="/img/versioned/0.10/assets/wide-ep.svg" alt="多节点宽专家并行">
  </picture>
</p>

请求流程如下：

* 请求到达代理，代理将请求转发给 EPP
* EPP 以 P/D 分离方式调度请求，通过标签识别 decode 和 prefill 变体。EPP 会调度到 LWS 中的特定 Pod
* 请求被路由到 Sidecar，Sidecar 将请求转发给 prefill Pod
* prefill 实例处理提示词，以 DP/EP 方式执行前向计算。DeepEP 执行跨节点的 dispatch/combine 集合通信。vLLM 返回如何获取 KV 块的元数据
* decode 实例通过 NIXL 经 RDMA（IB、RoCE、EFA）拉取 KV
* decode 实例执行 decode，以 DP/EP 方式执行前向计算。DeepEP 执行跨节点的 dispatch/combine 集合通信

## 延伸阅读 {#further-reading}

请参阅：

* [P/D 架构](../../architecture/advanced/disaggregation/README.md)，了解 llm-d 中分离的更多细节
* [vLLM 关于 DP 部署的文档](https://docs.vllm.ai/en/latest/serving/data_parallel_deployment/)
* [vLLM 关于 EP 部署的文档](https://docs.vllm.ai/en/latest/serving/expert_parallel_deployment/)
* [vLLM 关于 DeepEP 和 DeepGEMM 的文档](https://docs.vllm.ai/en/latest/design/fused_moe_modular_kernel/)
