# PromQL 查询参考

用于监控 llm-d 部署的、可直接使用的 PromQL 查询。可以在 Prometheus UI 中使用，也可以作为 Grafana 面板的基础。基于这些指标、可直接应用的默认告警集，请参阅[告警](./alerting.md)。

如需生成流量并填充错误指标以便测试，请使用[流量生成脚本](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/recipes/observability/generate-traffic-basic.sh)。

## 第一层：即时的故障与饱和指标 {#tier-1-immediate-failure--saturation-indicators}

发现异常时，请从这里开始排查。

| 指标需求 | PromQL 查询 |
| ----------- | ------------ |
| **总体错误率** | `sum(rate(llm_d_epp_request_error_total[5m])) / sum(rate(llm_d_epp_request_total[5m]))` |
| **按模型的错误率** | `sum by(model_name) (rate(llm_d_epp_request_error_total[5m])) / sum by(model_name) (rate(llm_d_epp_request_total[5m]))` |
| **请求抢占** | `sum by(pod, instance) (rate(vllm:num_preemptions[5m]))` |
| **总体延迟 P90** | `histogram_quantile(0.90, sum by(le) (rate(llm_d_epp_request_duration_seconds_bucket[5m])))` |
| **总体延迟 P99** | `histogram_quantile(0.99, sum by(le) (rate(llm_d_epp_request_duration_seconds_bucket[5m])))` |
| **按模型的 TTFT P99** | `histogram_quantile(0.99, sum by(le, model_name) (rate(vllm:time_to_first_token_seconds_bucket[5m])))` |
| **按模型的 TTFT P99（SGLang）** | `histogram_quantile(0.99, sum by(le, model_name) (rate(sglang_time_to_first_token_seconds_bucket[5m])))` |
| **token 间延迟 P99** | `histogram_quantile(0.99, sum by(le, model_name) (rate(vllm:inter_token_latency_seconds_bucket[5m])))` |
| **token 间延迟 P99（SGLang）** | `histogram_quantile(0.99, sum by(le, model_name) (rate(sglang_inter_token_latency_seconds_bucket[5m])))` |
| **请求速率** | `sum by(model_name) (rate(llm_d_epp_request_total[5m]))` |
| **GPU 利用率** | `avg by(gpu, node) (DCGM_FI_DEV_GPU_UTIL or nvidia_gpu_duty_cycle)` |
| **EPP 端到端延迟 P99** | `histogram_quantile(0.99, sum by(le) (rate(llm_d_epp_scheduler_e2e_duration_seconds_bucket[5m])))` |
| **EPP 插件延迟 P99** | `histogram_quantile(0.99, sum by(le, plugin_type) (rate(llm_d_epp_plugin_duration_seconds_bucket[5m])))` |

## 第二层：诊断深挖 {#tier-2-diagnostic-drill-down}

### GKE TPU 硬件 {#gke-tpu-hardware}

GKE TPU 硬件指标请参阅 [TPU 指标接口与检查](./tpu.md#metric-interface)。例如，`tensorcore_utilization{job="kube-system/tpu-metrics-exporter",make="cloud-tpu"}` 返回每条序列的利用率（百分比）；`memory_used{job="kube-system/tpu-metrics-exporter",make="cloud-tpu"}` 返回字节数。请替换为实际的抓取 job。这些 gauge 不需要 `rate()`。展示时请保留加速器和 instance 标签，并且不要用零替代缺失的序列。[TPU 仪表盘](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/recipes/observability/grafana/dashboards/llm-d-tpu-overview.json)增加了 instance、model 和 topology 过滤器。

### 基础模型服务 {#basic-model-serving}

| 指标需求 | PromQL 查询 |
| ----------- | ------------ |
| **KV 缓存利用率** | `avg by(pod, model_name) (vllm:kv_cache_usage_perc)` |
| **KV 缓存利用率（SGLang）** | `avg by(pod, model_name) (sglang_token_usage)` |
| **请求队列深度** | `sum by(pod, model_name) (vllm:num_requests_waiting)` |
| **请求队列深度（SGLang）** | `sum by(pod, model_name) (sglang_num_queue_reqs)` |
| **活跃请求数** | `avg by(pod) (vllm:num_requests_running)` |
| **活跃请求数（SGLang）** | `avg by(pod) (sglang_num_running_reqs)` |
| **总吞吐量**（token/秒） | `sum by(model_name, pod) (rate(vllm:prompt_tokens_total[5m]) + rate(vllm:generation_tokens_total[5m]))` |
| **总吞吐量（SGLang）**（token/秒） | `sum by(model_name, pod) (rate(sglang_prompt_tokens_total[5m]) + rate(sglang_generation_tokens_total[5m]))` |
| **生成 token 速率** | `sum by(model_name, pod) (rate(vllm:generation_tokens_total[5m]))` |
| **生成 token 速率（SGLang）** | `sum by(model_name, pod) (rate(sglang_generation_tokens_total[5m]))` |

### 路由与负载均衡 {#routing--load-balancing}

| 指标需求 | PromQL 查询 |
| ----------- | ------------ |
| **每个端点的 QPS** | `sum by(endpoint_name) (rate(llm_d_epp_scheduler_attempts_total{status="success"}[5m]))` |
| **各 Pod 的 token 分布** | `sum by(pod) (rate(vllm:prompt_tokens_total[5m]) + rate(vllm:generation_tokens_total[5m]))` |
| **各 Pod 的 token 分布（SGLang）** | `sum by(pod) (rate(sglang_prompt_tokens_total[5m]) + rate(sglang_generation_tokens_total[5m]))` |
| **路由决策延迟 P99** | `histogram_quantile(0.99, sum by(le) (rate(llm_d_epp_plugin_duration_seconds_bucket[5m])))` |

### 前缀缓存 {#prefix-caching}

| 指标需求 | PromQL 查询 |
| ----------- | ------------ |
| **缓存命中率** | `sum(rate(vllm:prefix_cache_hits_total[5m])) / sum(rate(vllm:prefix_cache_queries_total[5m]))` |
| **缓存命中率（SGLang）** | `avg(sglang_cache_hit_rate)` |
| **各 Pod 命中率** | `sum by(pod) (rate(vllm:prefix_cache_hits_total[5m])) / sum by(pod) (rate(vllm:prefix_cache_queries_total[5m]))` |
| **各 Pod 命中率（SGLang）** | `sglang_cache_hit_rate` |
| **EPP 前缀索引器大小** | `llm_d_epp_prefix_indexer_size` |
| **EPP 前缀命中率 P90** | `histogram_quantile(0.90, sum by(le) (rate(llm_d_epp_prefix_indexer_hit_ratio_bucket[5m])))` |

### 分层前缀缓存 {#tiered-prefix-cache}

用于[分层前缀缓存指南](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/tiered-prefix-cache)的查询。`vllm:kv_offload_*` 系列指标来自 vLLM 原生的 `OffloadingConnector`。

| 指标需求 | PromQL 查询 |
| ----------- | ------------ |
| **卸载层命中率** | `sum(rate(vllm:external_prefix_cache_hits_total[5m])) / sum(rate(vllm:external_prefix_cache_queries_total[5m]))` |
| **各 Pod 卸载存储速率（MiB/秒）** | `sum by(pod) (rate(vllm:kv_offload_store_bytes_total[5m])) / 1048576` |
| **各 Pod 卸载加载速率（MiB/秒）** | `sum by(pod) (rate(vllm:kv_offload_load_bytes_total[5m])) / 1048576` |
| **各 Pod 卸载加载速度（每秒加载时间对应的 MiB）** | `sum by(pod) (rate(vllm:kv_offload_load_bytes_total[5m])) / sum by(pod) (rate(vllm:kv_offload_load_time_total[5m])) / 1048576` |
| **5 分钟内卸载存储分配失败次数** | `sum by(pod) (increase(vllm:kv_offload_allocation_failure_total[5m]))` |
| **按层级的 EPP 前缀索引大小** | `sum by(plugin_name) (llm_d_epp_prefix_indexer_size)` |
| **按层级的 EPP 前缀命中率 P90** | `histogram_quantile(0.90, sum by(le, plugin_name) (rate(llm_d_epp_prefix_indexer_hit_ratio_bucket[5m])))` |
| **主机层使用率（SGLang HiCache）** | `sum by(pod) (sglang_hicache_host_used_tokens) / sum by(pod) (sglang_hicache_host_total_tokens)` |
| **由主机层提供的提示词 token 占比（SGLang HiCache）** | `sum(rate(sglang_cached_tokens_total{cache_source="host"}[5m])) / sum(rate(sglang_prompt_tokens_total[5m]))` |
| **检索命中率（LMCache）** | `avg by(pod) (lmcache:retrieve_hit_rate)` |

`vllm:external_prefix_cache_hits_total` 统计的是连接器在调度时报告为可用的 token 数，此时加载尚未完成。`vllm:kv_offload_load_bytes_total` 统计的是实际加载回 GPU 的字节数。

### Prefill/Decode 分离 {#prefilldecode-disaggregation}

| 指标需求 | PromQL 查询 |
| ----------- | ------------ |
| **Prefill 工作节点利用率** | `avg by(pod) (vllm:num_requests_running{pod=~".*prefill.*"})` |
| **Prefill 工作节点利用率（SGLang）** | `avg by(pod) (sglang_num_running_reqs{pod=~".*prefill.*"})` |
| **Decode KV 缓存利用率** | `avg by(pod) (vllm:kv_cache_usage_perc{pod=~".*decode.*"})` |
| **分离决策比例** | `sum(rate(llm_d_epp_disagg_decision_total{decision_type="prefill-decode"}[5m])) / sum(rate(llm_d_epp_disagg_decision_total[5m]))` |
| **NIXL 平均传输时间（ms）** | `sum(rate(vllm:nixl_xfer_time_seconds_sum[5m])) / sum(rate(vllm:nixl_xfer_time_seconds_count[5m])) * 1000` |
| **NIXL 传输时间 P95（ms）** | `histogram_quantile(0.95, sum by(le) (rate(vllm:nixl_xfer_time_seconds_bucket[5m]))) * 1000` |
| **NIXL 平均传输大小（MiB）** | `sum(rate(vllm:nixl_bytes_transferred_sum[5m])) / sum(rate(vllm:nixl_bytes_transferred_count[5m])) / 1048576` |
| **NIXL 传输数据量（MiB/秒）** | `sum(rate(vllm:nixl_bytes_transferred_sum[5m])) / 1048576` |
| **5 分钟内 NIXL 传输失败次数** | `sum(increase(vllm:nixl_num_failed_transfers[5m]))` |
| **5 分钟内 NIXL 通知失败次数** | `sum(increase(vllm:nixl_num_failed_notifications[5m]))` |
| **5 分钟内过期的 prefill KV 请求数** | `sum(increase(vllm:nixl_num_kv_expired_reqs[5m]))` |

NIXL 直方图的观测值是跨张量并行 rank 汇总的。其计数和平均大小描述的是 rank 级别的传输观测，而不是推理请求或整个请求的 KV 缓存大小。

### 流量控制 {#flow-control}

需要在 EPP 上启用 `flowControl` 特性开关。

| 指标需求 | PromQL 查询 |
| ----------- | ------------ |
| **队列大小** | `sum(llm_d_epp_flow_control_queue_size)` |
| **按优先级的队列大小** | `sum by(priority) (llm_d_epp_flow_control_queue_size)` |
| **队列等待时间 P99** | `histogram_quantile(0.99, sum by(le) (rate(llm_d_epp_flow_control_request_queue_duration_seconds_bucket[5m])))` |
| **资源池饱和度** | `llm_d_epp_flow_control_pool_saturation` |

## 说明 {#notes}

**指标名称前缀：**llm-d 0.10 / llm-d-router 0.11.0 移除了旧的 EPP 指标名称。请使用 `llm_d_epp_*`；如果查询没有返回数据，请核对已安装的路由器版本以及所需的特性开关。

**直方图：**使用 `histogram_quantile()` 时，务必包含 `by(le)`：

```promql
histogram_quantile(0.99, sum by(le) (rate(metric_name_bucket[5m])))
```

**错误指标**只有在第一次出错之后才会出现。测试时可以使用[流量生成脚本](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/recipes/observability/generate-traffic-basic.sh)来填充它们。
