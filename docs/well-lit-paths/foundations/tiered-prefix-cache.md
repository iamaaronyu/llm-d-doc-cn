# 分层前缀缓存

由于智能体工作负载具有多轮特性，前缀缓存的复用是高性能推理的关键因素。

模型服务器把 KV 缓存保存在 GPU 显存中，并采用 LRU 淘汰策略。一旦其他请求占满了空间，KV 缓存就会被淘汰，后续请求只能重新计算 prefill。不过，我们不必把 KV 缓存从 GPU 显存中直接丢弃，而是可以利用 CPU 内存、本地 NVMe 盘和网络存储系统等其他系统资源来存放被淘汰的 KV，并在需要时再拉回 GPU 显存。

这样可以增大 **KV 工作集**，扩大**感受野**（即 KV 缓存在系统中保留的时间）。

- 不使用 KV 卸载时：

```
   ┌───────┐           ┌─────────┐            ┌───────────┐
   │用户 A │           │ 用户 A  │            │  用户 A   │
   │ 请求  │           │   KV    │            │  后续请求 │
   │       │           │ 被淘汰  │            │           │
   └───┬───┘           └────┬────┘            └─────┬─────┘
       │                    │                       │
───────●────────────────────●───────────────────────●───────▶ 时间
       │                    │                       │
       t                   t+a                     t+b
       │                    │                       │
       │◄───── KV 存活 ────►│ ✗                     │
                                                    ▼
                                              ┌────────────┐
                                              │  重新计算  │
                                              │  PREFILL   │
                                              └────────────┘
```

- 使用 KV 卸载时：

```
   ┌───────┐           ┌─────────┐            ┌───────────┐
   │用户 A │           │ 用户 A  │            │  用户 A   │
   │ 请求  │           │   KV    │            │  后续请求 │
   │       │           │ 被卸载  │            │           │
   └───┬───┘           └────┬────┘            └─────┬─────┘
       │                    │                       │
───────●────────────────────●───────────────────────●───────▶ 时间
       │                    │                       │
       t                   t+a                     t+b
       │                    │                       │
       │◄─────────────── KV 存活 ──────────────────►│ ✓
                                                    ▼
                                              ┌────────────┐
                                              │    从      │
                                              │CPU 内存拉取│
                                              └────────────┘
```

:::info
CPU KV 缓存卸载开销很低，几乎不引入额外复杂度，几乎所有部署都可以启用。存储卸载则需要额外考量。
:::


## 存储层级 {#storage-tiers}

被卸载的 KV 缓存可以存放在多个层级上，按读写延迟排序：访问频繁的缓存离加速器最近，而较大或较冷的缓存则迁移到更慢、容量更大的层级。我们建议始终启用 HBM 和 CPU 内存两层，当工作集超过 HBM + CPU 内存时再增加文件系统层。

- **CPU 内存**——运维开销低，容量通常远大于加速器 HBM，因此是默认的卸载目标。在大多数情况下，从 CPU 内存加载比重新计算 prefill 更快，而且异步卸载带来的开销很小。
- **本地磁盘**——进一步增加容量，但比 CPU 内存慢。适用于工作负载能容忍额外延迟、且本地容量足够的场景。
- **共享（远程）存储**——提供与部署规模无关的容量、跨副本的 KV 缓存共享、快速扩容（新副本可复用已有缓存），并且在重启和故障后仍能保留。延迟和吞吐取决于底层系统，因此需要评估传输成本不会抵消带来的收益。成熟的企业级系统（例如 CephFS、GCP Lustre、IBM Storage Scale、AWS EFS）通过标准 POSIX 文件访问集成。
- **P2P 共享**——推理副本之间可以通过点对点网络共享 CPU 内存中的缓存，无需额外存储资源即可扩展共享范围。请参阅[启用 P2P 前缀缓存共享](enable-p2p-prefix-cache-sharing.md)。

## 部署 {#deploy}

清单文件和分步部署说明请参阅[分层前缀缓存指南](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/tiered-prefix-cache)。

## 架构 {#architecture}

llm-d 使用以下架构实现卸载。

### CPU KV 缓存卸载 {#cpu-kv-cache-offloading}

每个模型服务器通过自身的原生机制卸载到主机 CPU 内存：vLLM 使用 `OffloadingConnector`，SGLang 使用 HiCache。Pod 配置为启用该连接器，并提高 CPU 内存请求量（例如 400 GB）。被淘汰的 KV 缓存块会迁移到主机 CPU 内存而不是被丢弃，以几乎可以忽略的开销扩大有效缓存容量。EPP 维护一个全局索引，记录哪些块存在于哪些 Pod 的哪个层级上，并为 CPU 层的块额外添加一个 `prefix-cache-scorer` 插件。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)">
    <img src="/img/versioned/0.10/assets/cpu-offloading.svg" alt="CPU KV 缓存卸载">
  </picture>
</p>

### 分层卸载到文件系统 {#tiered-offloading-to-filesystem}

vLLM 的 `OffloadingConnector` 原生支持多级层次：HBM → CPU 内存 → 文件系统。通过 `TieringOffloadingSpec` 并配置一条 `type: fs` 的 `secondary_tiers` 条目，被淘汰的块会从 CPU 内存溢出到挂载在 `/mnt/files-storage` 的 ReadWriteMany PVC（后端为 Lustre、CephFS、IBM Storage Scale、AWS EFS 或类似系统）。I/O 是异步的，使用 GPU DMA，并在多个读写线程间并行。由于该层是共享的，新扩容的 Pod 可以立即读取已有缓存，并且缓存在 Pod 重启后依然保留；容量只受存储系统限制。

该连接器不会从共享层淘汰数据——容量由存储系统或外部控制器管理（[llm-d-kv-cache 仓库](https://github.com/llm-d/llm-d-kv-cache)中提供了一个参考实现的 PVC 淘汰器）。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)">
    <img src="/img/versioned/0.10/assets/fs-offloading.svg" alt="分层卸载到文件系统">
  </picture>
</p>

## 可观测性 {#observability}

只有当从 HBM 淘汰的块被加载回来、而不是被重新计算时，卸载才有意义。因此关键信号是卸载层的命中率、存储与加载的数据量，以及 EPP 的 CPU 前缀索引是否与模型服务器实际持有的内容一致。[分层前缀缓存指南中的“可观测性与故障排查”一节](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/tiered-prefix-cache#4-observability--troubleshooting)介绍了这条路径的关键指标和常见故障模式，并以共享的 [PromQL](../../operations/observability/promql.md#tiered-prefix-cache) 和[指标](../../operations/observability/metrics.md#vllm-kv-offloading-metrics)参考文档为支撑。

## 延伸阅读 {#further-reading}

- [分层前缀缓存指南](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/tiered-prefix-cache)——清单文件和分步部署说明。
- [vLLM KV 卸载连接器](https://vllm-project.github.io/2026/01/08/kv-offloading-connector.html)——原生 `OffloadingConnector` 及其分层机制的设计。
- [多级 KV 卸载 RFC](https://github.com/vllm-project/vllm/issues/38260)——上游的分层设计。
- [LMCache](https://lmcache.ai) 和 [SGLang HiCache](https://github.com/sgl-project/sglang)——本路径支持的其他卸载实现。
