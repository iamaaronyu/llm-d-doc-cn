# 模型服务器

模型服务器是在模型上运行推理的组件。llm-d 支持 vLLM、SGLang 和 TensorRT-LLM（`trtllm-serve`）作为模型服务器后端。

## 功能 {#functionality}

模型服务器把模型加载到一个或多个加速器（GPU、TPU 等）上，并为推理请求暴露受支持的 API，例如兼容 OpenAI 的 API。在 llm-d 架构中，模型服务器是计算层——它们执行实际生成 token 的 prefill 和 decode 步骤。

模型服务器是 llm-d 技术栈的最底层：

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)">
    <img src="/img/versioned/0.10/assets/basic-architecture.svg" alt="架构">
  </picture>
</p>

模型服务器独立于 llm-d 技术栈的其他部分进行部署。它们通过 Kubernetes 标签选择器自动加入 `InferencePool`，一旦健康，EPP 就开始向它们路由流量。

主要职责：

- 通过兼容 OpenAI 的 API（`/v1/completions`、`/v1/chat/completions`）**处理推理请求**
- **暴露指标**（KV 缓存利用率、队列深度、活跃请求数），供 EPP 进行智能调度
- 在 GPU 显存上**管理 KV 缓存**，包括针对重复提示词前缀的前缀缓存
- 为大模型**支持多种并行策略**，如张量并行（TP）、数据并行（DP）和专家并行（EP）

## EPP <-> 模型服务器协议 {#epp--model-server-protocol}

这是 EPP 与模型服务器之间的协议。

### 指标上报 {#metrics-reporting}

默认情况下，EPP 被配置为从模型服务器抓取指标，以做出最优的请求调度决策。在这种运行模式下，模型服务器必须（MUST）通过 Prometheus 端点提供以下指标。具体的指标名称不必与这里推荐的名称完全一致，但指标类型和语义必须（MUST）遵循本文档。

| 指标 | 类型 | 说明 | vLLM 指标 | Triton TensorRT-LLM| trtllm-serve | SGLang |
| ----- | ---- | ------------ | ---- | ---- | ---- | ---- |
| TotalQueuedRequests         | Gauge     | 当前队列中的请求总数。| `vllm:num_requests_waiting`| `nv_trt_llm_request_metrics{request_type=waiting}`| `trtllm_num_requests_waiting` | `sglang_num_queue_reqs`
| TotalRunningRequests         | Gauge     | 当前模型服务器上正在处理的请求总数。| `vllm:num_requests_running`| `nv_trt_llm_request_metrics{request_type=scheduled}`| `trtllm_num_requests_running` | `sglang_num_running_reqs`
| KVCacheUtilization| Gauge     | 当前 KV 缓存利用率（百分比）。| `vllm:kv_cache_usage_perc`| `nv_trt_llm_kv_cache_block_metrics{kv_cache_block_type=fraction}`| `trtllm_kv_cache_utilization` | `sglang_token_usage`
| [可选] BlockSize         | Labeled/Gauge     | 分配内存所用的块大小（以 token 计），供前缀缓存打分器使用。如果该指标不可用，BlockSize 将从[前缀插件配置](https://gateway-api-inference-extension.sigs.k8s.io/guides/epp-configuration/prefix-aware/#customize-the-prefix-cache-plugin)中推导。| 名称：`vllm:cache_config_info`，标签名：`block_size`| `nv_trt_llm_kv_cache_block_metrics{kv_cache_block_type=tokens_per}` | `trtllm_kv_cache_tokens_per_block` | 名称：`sglang_cache_config_info`，标签名：`page_size`
| [可选] NumGPUBlocks| Labeled/Gauge     | HBM KV 缓存中的块总数，供前缀缓存打分器使用。如果该指标不可用，NumGPUBlocks 将从[前缀插件配置](https://gateway-api-inference-extension.sigs.k8s.io/guides/epp-configuration/prefix-aware/#customize-the-prefix-cache-plugin)中推导。| 名称：`vllm:cache_config_info`，标签名：`num_gpu_blocks`| `nv_trt_llm_kv_cache_block_metrics{kv_cache_block_type=max}` | `trtllm_kv_cache_max_blocks` | 名称：`sglang_cache_config_info`，标签名：`num_pages`

为了正确映射指标名称，模型服务器 Pod 应按如下示例标注其运行的模型服务器类型。没有 engine-type 标签的 Pod 默认使用 vLLM 的指标名称。

```yaml
metadata:
  labels:
    llm-d.ai/engine-type: vllm # 其他可选值：sglang、trtllm-serve、triton-tensorrt-llm

```

:::note
**TensorRT-LLM（`trtllm-serve`）的要求。**与 vLLM/SGLang 不同，`trtllm-serve` 在 **`/prometheus/metrics`** 暴露上述指标。普通的 `/metrics` 路由返回的是 EPP 无法解析的 JSON 迭代统计数据，因此请将 EPP 的指标数据源指向 `path: /prometheus/metrics`。只有在服务器启动时**同时**设置 `return_perf_metrics: true` **和** `enable_iter_perf_stats: true`（两者默认均为 `false`，通过 `--extra_llm_api_options` 传入）时，才会输出这些 gauge 指标。前者挂载 Prometheus 端点，后者启动填充动态 gauge（`trtllm_num_requests_waiting`、`trtllm_num_requests_running`、`trtllm_kv_cache_utilization`）的迭代统计循环。它们需要 **TensorRT-LLM v1.3.0rc12 或更新版本**（在 [PR #12545](https://github.com/NVIDIA/TensorRT-LLM/pull/12545) 中加入）。更早的版本（包括 1.2.1 GA）只暴露请求生命周期直方图。可用配置请参阅[优化基线的 TensorRT-LLM 方案](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/optimized-baseline)。
:::


### LoRA 适配器服务 {#lora-adapter-serving}

支持动态 LoRA 服务的模型服务器可以受益于 LoRA 亲和性算法。注意，参考 EPP 中的现有算法高度偏向 vLLM 当前的动态 LoRA 实现。

只要请求的适配器有效，模型服务器必须（MUST）支持为请求 `model` 参数中指定的 LoRA 适配器提供服务。

模型服务器必须（MUST）通过同一个 Prometheus 端点暴露以下 LoRA 适配器指标：

- vLLM 中实现的指标名称：`vllm:lora_requests_info`
- 指标类型：Gauge
- 指标值：最后更新的时间戳（以便 EPP 找到最新的一条）。
- 指标标签：
  - `max_lora`：为处理一个批次可以加载到 GPU 显存中的最大适配器数量。如果模型服务器已达到 MaxActiveAdapter 且无法加载所请求的适配器，请求将被排队。示例：`"max_lora": "8"`。
  - `running_lora_adapters`：当前已加载到 GPU 显存中、可处理请求的适配器列表（逗号分隔）。示例：`"running_lora_adapters": "adapter1, adapter2"`
  - `waiting_lora_adapters`：等待被服务的适配器列表（逗号分隔）。示例：`"waiting_lora_adapters": "adapter1, adapter2"`

### 前缀缓存复用 {#prefix-cache-reuse}

EPP 支持针对前缀缓存优化的请求调度。为了从最优的前缀感知请求调度中获益，模型服务器应当（SHOULD）支持前缀缓存复用，例如 [vLLM 的自动前缀缓存](https://docs.vllm.ai/en/latest/features/automatic_prefix_caching.html)功能。

### 健康检查 {#health-checks}

模型服务器应暴露健康检查端点，供 Kubernetes 用于存活探针和就绪探针：

- **存活（Liveness）**：`GET /health`——确认服务器进程存活
- **就绪（Readiness）**：`GET /health`——确认服务器已准备好接收请求

## 延伸阅读 {#further-reading}

- [vLLM 文档](https://docs.vllm.ai/)
- [SGLang 文档](https://github.com/sgl-project/sglang)
- [TensorRT-LLM 文档](https://nvidia.github.io/TensorRT-LLM/)
- [InferencePool](inferencepool.md)——模型服务器如何被发现和管理
- [EPP](router/epp)——路由器如何依据模型服务器指标把请求路由到模型服务器
