# 前缀缓存感知路由

前缀缓存感知路由是由 **llm-d 路由器**（具体通过其**端点选择器（EPP）**组件）管理的一项核心技术，用于降低尾延迟并提升吞吐量。通过把请求路由到已经包含提示词前缀相关键值（KV）缓存的模型服务器副本，系统避免了冗余的“prefill”计算，节省了时间和加速器（GPU/TPU）资源。这项技术要求底层模型服务器支持跨请求的 KV 缓存，例如 vLLM 的[自动前缀缓存](https://docs.vllm.ai/en/latest/features/automatic_prefix_caching/)功能。

llm-d 为这项能力提供了两种不同的实现，以满足不同的运维要求和精度需求。

---

## 1. 近似实现 {#1-approximate-implementation}

近似实现设计得十分轻量，除标准 EPP 部署外不需要任何外部依赖。

### 组件 {#components}

- [**`approx-prefix-cache-producer`**](https://github.com/llm-d/llm-d-router/tree/v0.11.0/pkg/epp/framework/plugins/requestcontrol/dataproducer/approximateprefix)（DataProducer 插件）
- [**`prefix-cache-scorer`**](https://github.com/llm-d/llm-d-router/tree/v0.11.0/pkg/epp/framework/plugins/scheduling/scorer/prefix)（Scorer 插件）

### 工作原理 {#how-it-works}

1. **近似**：由于 EPP 本身不包含分词器，它使用字符与 token 的比例来近似估算 token。
2. **哈希**：`approx-prefix-cache-producer` 把传入的提示词切分为固定大小的块（例如以字符近似的 16 个 token），并构建滚动哈希链。
3. **本地索引**：EPP 在内存中维护一个 LRU 索引，记录最近哪些前缀哈希被发送到了哪些 Pod。
4. **打分**：`prefix-cache-scorer` 读取匹配信息，并根据匹配块数占提示词总块数的比例给出分数。
5. **学习**：做出路由决策后，EPP 更新其本地索引，假定选中的 Pod 此后会持有该前缀。

### 优缺点 {#pros--cons}

- **优点**：极其轻量；不需要分词器 Sidecar；不需要与模型服务器建立网络连接（ZMQ）；不需要模型服务器显式集成，因为它不要求模型服务器上报 KV 缓存事件。
- **缺点**：可能与模型服务器的实际状态产生偏差（例如某个 Pod 因内存压力淘汰了某个前缀）；精度低于基于 token 的匹配。

---

## 2. 精确实现 {#2-precise-implementation}

精确实现利用真实的 token 数据和来自模型服务器的实时状态更新，提供 100% 的准确性。

### 组件 {#components-1}

- [**`token-producer`**](https://github.com/llm-d/llm-d-router/tree/v0.11.0/pkg/epp/framework/plugins/requestcontrol/dataproducer/tokenizer)（DataProducer 插件）
- [**`precise-prefix-cache-producer`**](https://github.com/llm-d/llm-d-router/tree/v0.11.0/pkg/epp/framework/plugins/requestcontrol/dataproducer/preciseprefixcache)（DataProducer 插件）——持有 KV 块索引
- [**`prefix-cache-scorer`**](https://github.com/llm-d/llm-d-router/tree/v0.11.0/pkg/epp/framework/plugins/scheduling/scorer/prefix)（Scorer 插件）——通过 `prefixMatchInfoProducerName: precise-prefix-cache-producer` 使用该生产者的匹配信息打分
- **KV 缓存索引器**（EPP 数据层组件）

### 工作原理 {#how-it-works-1}

1. **精确分词**：`token-producer` 插件把提示词发送到 vLLM 的 HTTP render 端点（`/v1/completions/render`）——通常是 EPP Pod 中的一个 `vllm launch render` Sidecar（回环访问）或一个共享的 render Service——以获取精确的 Token ID。（旧的基于 UDS 的 gRPC 分词器后端已弃用。）
2. **实时事件**：模型服务器（如 vLLM）被配置为，每当其内部 KV 缓存发生变化（新增或淘汰块）时，通过 ZeroMQ（ZMQ）发出 `KVEvents`。
3. **全局索引**：**KV 缓存索引器**订阅这些事件，维护一个精确的、全局一致的视图，准确记录哪些 token 块驻留在哪些 Pod 上。
4. **精确匹配**：`prefix-cache-scorer` 读取 `precise-prefix-cache-producer` 的匹配信息，根据精确的 Token ID 前缀有多少驻留在全局索引中，为每个候选 Pod 打分。
5. **推测性索引**：为了消除从路由决策到后续 `KVEvent` 到达之间的“盲区”，生产者可以在路由后立即主动向索引中添加“推测性”条目。

### 优缺点 {#pros--cons-1}

- **优点**：100% 精确；能处理复杂的缓存淘汰策略；原生支持 Prefill/Decode 分离（通过识别需要传输的具体块）。
- **缺点**：需要额外的基础设施（vLLM render 端点、ZMQ 连通性）；资源开销略高；要求模型服务器支持发出 KV 缓存事件。

---

## 对比总结 {#comparison-summary}

| 特性 | 近似 | 精确 |
|---|---|---|
| **精度** | 启发式（基于字符） | 100%（基于 token） |
| **状态来源** | EPP 本地假设 | 来自模型服务器的实时 `KVEvents` |
| **依赖** | 无 | vLLM render 端点、ZMQ |
| **适用场景** | 简单、同构的工作负载 | 复杂、大规模的生产服务 |
| **P/D 分离支持** | 基础 | 高级/原生 |

### 与 KV 缓存管理的组合 {#composition-with-kv-cache-management}

两种实现都是 llm-d 更广泛的 **KV 缓存管理**生态的一部分。近似实现是自包含的，而精确实现依赖于 [KV 缓存索引器](kv-indexer.md)，并可以与 [KV 卸载](kv-offloader.md)协同工作，跨加速器和主机内存边界管理缓存状态。
