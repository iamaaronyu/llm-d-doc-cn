# 分离式服务运维

分离式服务把 LLM 推理的 **prefill** 和 **decode** 阶段放到不同的模型服务器实例上。虽然分离式服务在性能和资源效率上更有优势，但它在动态连接、请求取消、容错和安全发布方面带来了运维复杂度。

关于架构概览、请求流编排以及 KV 缓存传输的基础知识，请参阅[分离式服务概念](../../architecture/advanced/disaggregation/README.md)页面。

## 各引擎运维指南 {#engine-operations-guides}

运维行为因模型服务器引擎而异：

* **[vLLM 运维](./vllm.md)**——通过 NIXL 点对点握手建立动态连接、基于租约的 KV 块管理、容错策略（`fail` 与 `recompute`）以及发布兼容性。
* **[SGLang 运维](./sglang.md)**——通过 prefill 引导服务器惰性建立连接、基于心跳的故障隔离、等待超时以及发布兼容性。
