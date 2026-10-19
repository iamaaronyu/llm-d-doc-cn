# 指标

本页介绍如何启用和解读 llm-d 部署的指标。关于 Prometheus 和 Grafana 的安装，请先参阅[可观测性部署](./setup.md)。

:::note
本页中的命令使用 `${NAMESPACE}` 表示运行 llm-d 工作负载的命名空间。开始之前请先设置它：

```bash
export NAMESPACE=<your-llm-d-namespace>
```
:::


## 前提条件 {#prerequisites}

- 一套带有 InferencePool 和模型服务器的运行中 llm-d 部署——如有需要，请参阅[快速开始](../../getting-started/quickstart.md)
- 已安装 Prometheus 和 Grafana——参见[可观测性部署](./setup.md)

:::note
TPU 硬件指标需要使用 [GKE TPU 监控方案](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/recipes/observability/tpu/)，它抓取的是 GKE 设备插件的导出器，而不是模型服务器。
[GKE TPU 可观测性](./tpu.md)记录了指标名称、单位、标签以及环境检查方法。指标是否可用取决于 GKE 运行时和 TPU 类型；仅凭 vLLM 镜像版本无法确定这一接口。
:::


## 第 1 步：启用模型服务器指标 {#step-1-enable-model-server-metrics}

模型服务器指标默认启用。具体配置因部署方式而异。

### Kustomize 部署 {#kustomize-deployments}

如果你使用 `kustomize build` 部署模型服务器，请把 monitoring 组件加入 `kustomization.yaml`：

```yaml
components:
  - ../../../recipes/modelserver/components/monitoring       # decode PodMonitor
  # - ../../../recipes/modelserver/components/monitoring-pd  # prefill/decode 分离时添加
```

monitoring 组件会创建抓取模型服务器指标的 PodMonitor。详情请参阅 [`guides/recipes/modelserver/components/monitoring/`](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/recipes/modelserver/components/monitoring/)。

### 验证 PodMonitor {#verify-podmonitors}

确认 PodMonitor 存在：

```bash
kubectl get podmonitors -n ${NAMESPACE}
```

预期输出：

```text
NAME                    AGE
decode-podmonitor       5m
prefill-podmonitor      5m
```

### 关键 vLLM 指标 {#key-vllm-metrics}

| 指标 | 衡量内容 | 为什么重要 |
| -------- | ----------------- | ---------------- |
| `vllm:num_requests_running` | 正在处理的活跃请求数 | 数值高表示 GPU 饱和；新请求将会排队。注意持续的尖峰 |
| `vllm:num_requests_waiting` | 排队等待处理的请求数 | 非零表示 Pod 已饱和。是自动扩缩容决策的主要信号 |
| `vllm:kv_cache_usage_perc` | KV 缓存利用率（0.0 到 1.0） | 高于 0.9 表示 GPU 显存几乎已满，请求可能会被抢占或拒绝 |
| `vllm:time_to_first_token_seconds`（直方图） | 从请求到达到生成第一个 token 的时间（TTFT） | 直接影响用户体验。使用 `histogram_quantile()` 查询分位数 |
| `vllm:inter_token_latency_seconds`（直方图） | 连续生成的 token 之间的时间（ITL） | 影响流式响应的速度。ITL 高会导致输出断断续续。使用 `histogram_quantile()` 查询分位数 |
| `vllm:prefix_cache_hits_total` | 前缀缓存命中次数 | 与 `prefix_cache_queries_total` 对比得到命中率。命中率低说明 EPP 的路由效果不佳 |
| `vllm:prefix_cache_queries_total` | 前缀缓存查找总次数 | 用 `prefix_cache_hits_total` 除以它得到命中率。比率下降说明路由或提示词模式发生了变化 |
| `vllm:prompt_tokens_total` | 处理的输入 token 总数 | 使用 `rate()` 得到每个 Pod 的 token/秒。在各 Pod 之间对比可发现负载分布不均 |
| `vllm:generation_tokens_total` | 生成的输出 token 总数 | 与提示词 token 一起使用 `rate()` 得到总吞吐量。下降说明模型性能退化 |

#### vLLM NIXL KV 传输指标 {#vllm-nixl-kv-transfer-metrics}

当 vLLM 使用 `NixlConnector` 进行分离式服务时，会导出工作节点之间 KV 缓存传输的指标。配置细节请参阅 [vLLM NixlConnector 使用指南](https://docs.vllm.ai/en/latest/features/nixl_connector_usage/)。

| 指标 | 衡量内容 | 为什么重要 |
| -------- | ------------------ | ---------------- |
| `vllm:nixl_xfer_time_seconds`（直方图） | 从提交传输到后端报告完成的时间，包括提交和数据搬运 | 尾延迟高可能意味着网络拥塞、传输量大或后端延迟 |
| `vllm:nixl_post_time_seconds`（直方图） | 向后端提交传输所花的同步时间 | 如果该值高而传输时间正常，说明开销在于描述符设置或提交 |
| `vllm:nixl_bytes_transferred`（直方图） | 每次传输观测搬运的字节数 | 反映传输大小和 KV 缓存数据量 |
| `vllm:nixl_num_descriptors`（直方图） | 每次传输观测的内存描述符数量 | 数量高可能意味着 KV 缓存分配碎片化或体积较大 |
| `vllm:nixl_num_failed_transfers`（计数器） | 失败的 NIXL KV 缓存传输次数 | 传输失败可能使消费端无法使用远端的 KV 块 |
| `vllm:nixl_num_failed_notifications`（计数器） | 失败的传输完成通知次数 | 通知失败可能使对端无法得知传输已完成 |
| `vllm:nixl_num_kv_expired_reqs`（计数器） | KV 块在 decoder 读取之前就已过期的请求数；在 prefill 实例上记录 | 持续增长可能意味着 `kv_lease_duration` 对该工作负载或网络来说太短 |

:::note
在使用张量并行时，vLLM 会在导出之前汇总所有 TP rank 的传输观测值。因此，直方图计数表示的是 rank 级别的传输观测，而不是推理请求，字节值也不代表一个请求在所有 rank 上的总大小。这些是聚合的 Prometheus 指标，与单个请求或追踪 ID 没有关联。
:::


#### vLLM KV 卸载指标 {#vllm-kv-offloading-metrics}

当 vLLM 使用原生的 `OffloadingConnector`（[分层前缀缓存指南](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/tiered-prefix-cache)）时，会导出在 GPU 与卸载层之间搬运 KV 块的指标。下列名称在 vLLM v0.26.0 及更新版本中可用。

| 指标 | 衡量内容 | 为什么重要 |
|--------|------------------|----------------|
| `vllm:external_prefix_cache_queries_total` | 通过 KV 连接器查找的提示词 token 数 | 卸载层命中率的分母 |
| `vllm:external_prefix_cache_hits_total` | 连接器在调度时报告为已缓存的提示词 token 数 | 卸载层命中。在加载完成之前就已计数，因此请与加载字节数一起解读 |
| `vllm:kv_offload_store_bytes_total` | 从 GPU 存入卸载层的字节数 | 进入该层的淘汰流量 |
| `vllm:kv_offload_load_bytes_total` | 从卸载层加载回 GPU 的字节数 | 确认被卸载的块正在被复用 |
| `vllm:kv_offload_store_time_total`、`vllm:kv_offload_load_time_total` | 存储和加载的总时间（秒） | 用字节数除以时间得到有效传输速度 |
| `vllm:kv_offload_allocation_failure_total` | 无法分配卸载块的存储尝试次数 | 持续增长意味着 CPU 层空闲或可淘汰的块太少 |
| `vllm:kv_offload_cpu_cache_usage_perc` | 被进行中的传输锁定的 CPU 层占比（0.0 到 1.0） | 这不是占用率。持续接近 1.0 意味着存储可能被丢弃 |

:::note
较旧的仪表盘可能使用带有 `transfer_type` 标签（`GPU_to_CPU`、`CPU_to_GPU`）的 `vllm:kv_offload_total_bytes_total`、`vllm:kv_offload_total_time_total` 和 `vllm:kv_offload_size`。vLLM 仍然会为 `CPUOffloadingSpec` 及其子类（涵盖 CPU 内存和文件系统两条路径）输出它们，但它们已被弃用，推荐使用上面的系列。
:::


### 关键 SGLang 指标 {#key-sglang-metrics}

| 指标 | 衡量内容 | 为什么重要 |
| -------- | ----------------- | ---------------- |
| `sglang_num_running_reqs` | 正在处理的活跃请求数 | 数值高表示 GPU 饱和；新请求将会排队 |
| `sglang_num_queue_reqs` | 排队等待处理的请求数 | 非零表示 Pod 已饱和。是自动扩缩容决策的主要信号 |
| `sglang_token_usage` | KV 缓存 token 利用率（0.0 到 1.0） | 高于 0.9 表示 GPU 显存几乎已满 |
| `sglang_cache_hit_rate` | 前缀缓存命中率（0.0 到 1.0） | 命中率高说明 KV 缓存复用效率高 |
| `sglang_time_to_first_token_seconds`（直方图） | 从请求到达到生成第一个 token 的时间（TTFT） | 直接影响用户体验。使用 `histogram_quantile()` 查询分位数 |
| `sglang_inter_token_latency_seconds`（直方图） | 连续生成的 token 之间的时间（ITL） | 影响流式响应的速度。使用 `histogram_quantile()` 查询分位数 |
| `sglang_prompt_tokens_total` | 处理的输入 token 总数 | 使用 `rate()` 得到每个 Pod 的 token/秒 |
| `sglang_generation_tokens_total` | 生成的输出 token 总数 | 与提示词 token 一起使用 `rate()` 得到总吞吐量 |

#### SGLang HiCache 指标 {#sglang-hicache-metrics}

启用 HiCache 时（[分层前缀缓存指南](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/tiered-prefix-cache)中的 SGLang 路径），SGLang 会导出主机（CPU）层的指标。

| 指标 | 衡量内容 | 为什么重要 |
|--------|------------------|----------------|
| `sglang_hicache_host_used_tokens` | 当前保存在主机 KV 缓存中的 token 数 | 除以 `sglang_hicache_host_total_tokens` 得到主机层占用率 |
| `sglang_hicache_host_total_tokens` | 以 token 计的主机 KV 缓存容量 | 主机层占用率的分母 |
| `sglang_evicted_tokens_total` | 从 GPU 淘汰到主机的 token 数 | 进入主机层的淘汰流量 |
| `sglang_load_back_tokens_total` | 从主机加载回 GPU 的 token 数 | 确认主机层的块正在被复用 |
| `sglang_load_back_duration_seconds`（直方图） | 把 KV 缓存从主机加载回 GPU 的时间 | 加载回来过慢会抵消卸载带来的 TTFT 收益 |
| `sglang_cached_tokens_total` | 按 `cache_source`（`device`、`host`、`storage_<backend>`，未拆分时为 `total`）统计的已缓存提示词 token 数 | 把前缀缓存命中归属到各个层级 |

## 第 3 步：启用 EPP 指标 {#step-3-enable-epp-metrics}

EPP（端点选择器）指标默认启用。如需验证或手动启用，请参阅 llm-d-router Helm Chart 文档中的[监控与追踪配置](https://github.com/llm-d/llm-d-router/tree/v0.11.0/config/charts#4-monitoring--tracing-configuration)一节。

确认 ServiceMonitor 存在：

```bash
kubectl get servicemonitors -n ${NAMESPACE}
```

预期输出：

```text
NAME                    AGE
epp-servicemonitor      5m
```

### 关键 llm-d 路由器 EPP 指标 {#key-llm-d-router-epp-metrics}

EPP 以 `llm_d_epp_` 为前缀暴露 Prometheus 指标。

#### 请求与延迟 {#request-and-latency}

| 指标 | 衡量内容 | 为什么重要 |
| -------- | ----------------- | ---------------- |
| `llm_d_epp_request_total` | 按流 ID 和优先级统计的请求总数 | 计算各模型错误率和吞吐量的基线 |
| `llm_d_epp_request_error_total` | 按流 ID 和优先级统计的错误数 | 错误上升说明后端故障。错误率超过 5% 时告警 |
| `llm_d_epp_request_duration_seconds` | 按流 ID 和优先级统计的响应延迟分布 | SLO 指标。跟踪从请求到响应的完整往返时间 |
| `llm_d_epp_request_size_bytes` | 按流 ID 和优先级统计的传入请求大小分布（字节） | 有助于发现载荷大小异常以及特别大的传入提示词 |
| `llm_d_epp_response_size_bytes` | 按流 ID 和优先级统计的传出响应大小分布（字节） | 跟踪传出带宽使用以及响应载荷大小分布 |
| `llm_d_epp_request_input_tokens` | 按流 ID 和优先级统计的输入 token 数分布 | 有助于识别昂贵的请求。长提示词消耗更多算力 |
| `llm_d_epp_request_output_tokens` | 按流 ID 和优先级统计的输出 token 数分布 | 结合时长，可得出归一化成本和每 token 的生成量 |
| `llm_d_epp_request_cached_tokens` | 按流 ID 和优先级统计的已缓存提示词 token 分布 | 衡量模型服务器上报的前缀缓存利用情况 |
| `llm_d_epp_request_running` | 按流 ID 和优先级统计的活跃请求数 | 展示各模型的实时负载并发 |
| `llm_d_epp_request_ntpot_seconds` | 按流 ID 和优先级统计的归一化每输出 token 时间（NTPOT）分布 | 关键的效率指标（越低越好）。在各 Pod 之间对比以找出拖后腿的 Pod |
| `llm_d_epp_request_ttft_seconds` | 按流 ID 和优先级统计的首 token 时间（TTFT）分布 | 直接衡量用户感知的响应速度以及首个输出字节的时间 |
| `llm_d_epp_request_streaming_tpot_seconds` | 按流 ID 和优先级统计的每输出 token 时间（TPOT）分布；适用于流式请求 | 跟踪不含初始提示词 prefill 延迟的持续生成速度 |
| `llm_d_epp_request_streaming_itl_seconds` | 按流 ID 和优先级统计的 token 间延迟（ITL）分布；适用于流式请求 | 衡量连续响应体分块之间的节奏；尖峰表示输出断断续续 |

#### 推理资源池 {#inference-pool}

| 指标 | 衡量内容 | 为什么重要 |
| -------- | ----------------- | ---------------- |
| `llm_d_epp_ready_endpoints` | 资源池中就绪的端点数 | 如果低于预期数量，说明 Pod 正在崩溃或无法调度 |
| `llm_d_epp_average_kv_cache_utilization` | 资源池的平均 KV 缓存利用率 | 平均利用率高说明资源池接近内存容量上限 |
| `llm_d_epp_average_queue_size` | 各模型服务器的平均队列深度 | 资源池饱和以及自动扩缩容决策的主要信号 |
| `llm_d_epp_average_running_requests` | 各模型服务器的平均运行中请求数 | 跟踪各端点的并发 |
| `llm_d_epp_std_dev_kv_cache_utilization` | 各端点 KV 缓存利用率的离散程度 | 标准差高说明缓存分布不均 |
| `llm_d_epp_std_dev_queue_size` | 各端点队列深度的离散程度 | 方差高说明路由不均衡 |
| `llm_d_epp_std_dev_running_requests` | 各端点进行中请求数的离散程度 | 有助于诊断拖后腿的 Pod 或热点 |
| `llm_d_epp_per_endpoint_queue_size` | 每个端点的队列深度 | 识别过载的模型服务器副本 |

#### 调度器、插件与处理开销 {#scheduler-plugins--processing-overhead}

| 指标 | 衡量内容 | 为什么重要 |
| -------- | ----------------- | ---------------- |
| `llm_d_epp_scheduler_attempts_total` | 调度尝试次数及结果 | 跟踪失败的调度尝试。失败率高说明过滤器/打分器配置有误 |
| `llm_d_epp_scheduler_e2e_duration_seconds` | 端到端调度延迟分布 | 跟踪在 EPP 调度周期内花费的延迟 |
| `llm_d_epp_plugin_duration_seconds` | 每个插件的处理延迟分布 | 识别缓慢或成为瓶颈的调度插件 |
| `llm_d_epp_plugin_data_scope_violations_total` | 因未声明 DataKey 而被拒绝的端点属性访问总数 | 非零值说明插件实现与其声明不一致 |
| `llm_d_epp_request_processing_duration_seconds` | 从收到请求到请求体处理完成的时间 | 衡量 EPP 的请求摄入和准入开销 |
| `llm_d_epp_response_processing_duration_seconds` | EPP 响应处理延迟 | 衡量响应流处理器的开销 |
| `llm_d_epp_info` | 构建信息（`commit`、`build_ref`） | 核对正在运行的二进制版本和构建详情 |
| `llm_d_epp_model_rewrite_decisions_total` | 模型重写决策总数 | 跟踪各重写规则下的请求重写 |

#### 进行中负载 {#in-flight-load}

| 指标 | 衡量内容 | 为什么重要 |
| -------- | ----------------- | ---------------- |
| `llm_d_epp_inflight_requests` | 每个端点上当前进行中的请求数 | 每个副本的队列深度，用于负载感知路由和容量分析 |
| `llm_d_epp_inflight_tokens` | 每个端点上当前进行中的 token 数 | 每个副本的 token 压力，比请求数更精细的负载信号 |

#### 分离与发布 {#disaggregation--rollout}

| 指标 | 衡量内容 | 为什么重要 |
| -------- | ----------------- | ---------------- |
| `llm_d_epp_disagg_decision_total` | 各分离阶段的路由决策 | 跟踪仅 decode、prefill-decode、encode-decode 以及完整流水线决策的分布 |
| `llm_d_epp_pd_decision_total` | Prefill/decode 分离决策（已弃用的处理器） | 用于 P/D 路由决策的向后兼容计数器 |
| `llm_d_epp_disaggregatedset_strict_header_no_match_total` | 未匹配到任何端点的严格请求头选择次数 | 暴露会导致失败关闭（fail closed）的严格选择器配置错误 |
| `llm_d_epp_disaggregatedset_revision_gating_share` | 当前的加权修订版本门控份额（0 到 1） | 监控分离式修订版本之间的金丝雀和滚动部署份额 |

#### 流量控制指标 {#flow-control-metrics}

启用流量控制（`flowControl` 特性开关）后，会额外暴露以下指标：

| 指标 | 衡量内容 | 为什么重要 |
| -------- | ----------------- | ---------------- |
| `llm_d_epp_flow_control_queue_size` | 按流 ID 和优先级统计的排队请求数 | 队列增长说明资源池跟不上。考虑扩容或调整优先级档 |
| `llm_d_epp_flow_control_queue_bytes` | 按流 ID 和优先级统计的排队载荷大小（字节） | 大量排队载荷可能耗尽 EPP 内存。请结合 `maxBytes` 配置监控 |
| `llm_d_epp_flow_control_request_queue_duration_seconds` | 按流 ID 和优先级统计的排队时长分布 | 直接影响用户感知的延迟。数值高说明流量控制暂存请求的时间过长 |
| `llm_d_epp_flow_control_dispatch_cycle_duration_seconds` | 内部分发周期时长分布 | 跟踪流量控制调度循环的执行速度 |
| `llm_d_epp_flow_control_request_enqueue_duration_seconds` | 按流 ID 和优先级统计的请求入队时长分布 | 衡量进入流量控制队列的准入开销 |
| `llm_d_epp_flow_control_pool_saturation` | 资源池饱和程度（0.0 到 1.0+） | 高于 1.0 表示需求超过容量，流量控制正在主动限流。请扩容或削减负载 |
| `llm_d_epp_flow_control_stale_endpoints` | 遥测数据缺失或过期的端点数 | 非零值说明是指标采集问题，而不是真正的过载 |
| `llm_d_epp_flow_control_requests_total` | 流量控制按结果统计的已处理请求总数 | 拒绝（`outcome="RejectedCapacity"`）和驱逐比例的直接信号 |
| `llm_d_epp_flow_control_revocations_issued_total` | 按优先级统计的已发出进行中驱逐撤销总数 | 跟踪争用情况下主动回收容量的事件 |
| `llm_d_epp_flow_control_revocations_total` | 按结果（`confirmed`、`timed_out`）统计的进行中驱逐撤销总数 | 确认流取消是成功还是超时 |
| `llm_d_epp_flow_control_reclaim_target` | 最近一次计算出的回收缺口 | 衡量驱动撤销的容量缺口 |
| `llm_d_epp_flow_control_pending_reclaim` | 未完成及冷却中的待回收借记 | 跟踪确认之前的进行中回收借记 |
| `llm_d_epp_flow_control_revocation_confirmation_seconds` | 从发出撤销到确认终止的时长 | 进行中驱逐完成的延迟信号 |
| `llm_d_epp_program_aware_jains_fairness_index` | 各活跃程序之间的 Jain 公平性指数 | 量化相互竞争的程序之间的公平程度 |
| `llm_d_epp_program_aware_avg_wait_time_milliseconds` | 每个程序的平均排队等待时间（毫秒） | 监控每个程序的排队延迟 |
| `llm_d_epp_program_aware_attained_service_tokens` | 每个程序随时间衰减的已获得服务量 | 跟踪用于最少已获服务（LAS）调度的历史消耗 |

#### 前缀与多模态缓存 {#prefix--multimodal-cache}

| 指标 | 衡量内容 | 为什么重要 |
| -------- | ----------------- | ---------------- |
| `llm_d_epp_prefix_indexer_size` | 近似前缀索引中的条目数 | 跟踪索引的内存占用 |
| `llm_d_epp_prefix_indexer_hit_ratio` | 前缀匹配命中率分布 | 命中率高说明前缀缓存有效 |
| `llm_d_epp_prefix_indexer_hit_bytes` | 每次前缀查找匹配的字节数 | 量化从缓存中复用的数据 |
| `llm_d_epp_encoder_cache_queries_total` | 多模态编码器缓存查找总数 | 针对缓存查询的多模态条目数量 |
| `llm_d_epp_encoder_cache_hits_total` | 每个 Pod 的编码器缓存命中次数 | 跟踪多模态嵌入缓存的复用 |
| `llm_d_epp_encoder_cache_hit_ratio` | 编码器缓存查找的命中率分布 | 暴露各 Pod 之间不均匀的多模态缓存局部性 |

#### 预测延迟与 SLO {#predicted-latency--slo}

| 指标 | 衡量内容 | 为什么重要 |
| -------- | ----------------- | ---------------- |
| `llm_d_epp_request_predicted_ttft_seconds` | 预测的 TTFT 分布 | 由基于延迟的调度用于评估候选 |
| `llm_d_epp_request_ttft_prediction_duration_seconds` | 计算 TTFT 预测所花的时间 | 衡量预测器 Sidecar 的开销 |
| `llm_d_epp_request_predicted_tpot_seconds` | 预测的 TPOT 分布 | 评估各后端的 token 生成延迟 |
| `llm_d_epp_request_tpot_prediction_duration_seconds` | 计算 TPOT 预测所花的时间 | 衡量 TPOT 预测器的执行延迟 |
| `llm_d_epp_request_slo_violation_total` | 违反所配置延迟 SLO 的请求数 | SLO 退化的主要告警信号 |
| `llm_d_epp_inference_request_metric` | 观测到的请求指标和 SLO 状态的汇总 Gauge | 以单一序列灵活导出 TTFT、TPOT 和 SLO 指标 |

#### ext_proc 流与数据层错误 {#ext_proc-streams--data-layer-errors}

| 指标 | 衡量内容 | 为什么重要 |
| -------- | ----------------- | ---------------- |
| `llm_d_epp_extproc_streams_inflight` | 打开的 ext_proc gRPC 流数量（可选启用） | 监控 Envoy↔EPP 的 gRPC 流连接 |
| `llm_d_epp_extproc_stream_duration_seconds` | ext_proc gRPC 流保持打开的时长 | 时长突然变短表示流频繁重连 |
| `llm_d_epp_extproc_streams_total` | 按状态码统计的已完成 ext_proc gRPC 流 | 暴露异常的流断开和错误 |
| `llm_d_epp_datalayer_poll_errors_total` | 按来源类型统计的数据来源轮询失败次数 | 表明从模型服务器抓取遥测数据失败 |
| `llm_d_epp_datalayer_extract_errors_total` | 按来源/提取器类型统计的提取器失败次数 | 表明解析抓取到的遥测载荷失败 |

### 关键批处理网关指标 {#key-batch-gateway-metrics}

仅在部署了[批处理网关指南](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/batch-serving/batch-gateway)时才相关。以下是运维上有用的序列；名称、类型和标签的权威定义来源是组件仓库中的 [`docs/guides/metrics.md`](https://github.com/llm-d/llm-d-batch-gateway/blob/v0.6.0/docs/guides/metrics.md)，其中还记录了此处未列出的 token、取消和启动恢复计数器。

与上面的 EPP 和 vLLM 指标不同，这些名称没有 `llm_d_` 前缀，因此请按 `namespace` 限定查询范围，以免采集到无关的工作负载。

| 指标 | 衡量内容 | 为什么重要 |
| -------- | ----------------- | ---------------- |
| `http_requests_total` | 按方法、路径和状态统计的 API 服务器请求数 | API 侧错误率的基线——批处理提交失败会体现在这里，而不是作业指标中 |
| `http_request_duration_seconds` | API 服务器请求延迟分布 | 提交和状态轮询的响应速度 |
| `jobs_processed_total` | 按 `result`（`success`、`failed`、`skipped`、`re_enqueued`、`expired`）和 `reason` 统计的已处理作业数 | 主要的结果信号。`expired` 表示作业在运行前就已过期，这是容量问题而不是故障 |
| `job_queue_wait_duration_seconds` | 作业被取走之前在优先级队列中的时间 | 积压的领先指标；会先于端到端延迟上升 |
| `job_processing_duration_seconds` | 按 `size_bucket` 统计的端到端处理时长 | 区分“大作业慢”和“所有作业都慢” |
| `batch_job_e2e_latency_seconds` | 从提交到终止状态的时长，按 `status` 统计 | 用户实际等待的时间，包括排队时间 |
| `active_workers` / `total_workers` | 活跃与已配置的工作池大小 | 两者之比是饱和信号——持续接近 1.0 表示工作池是瓶颈 |
| `processor_inflight_requests` | 执行过程中进行中的推理请求数 | 批处理路径施加在推理后端上的负载 |
| `batch_reconciler_errors_total` | GC 调谐器周期错误数 | 非零表示孤儿作业没有被恢复 |
| `batch_reconciler_orphans_recovered_total` | 按 `action` 统计的已恢复孤儿数 | 持续非零指向上游的处理器崩溃 |
| `file_storage_operations_total` | 按 `operation`、`component` 和 `status` 统计的文件存储操作数 | `status="exhausted"` 表示重试已放弃——输入或输出数据无法访问 |

:::note
批处理网关仪表盘在应用 `histogram_quantile` 之前，会先把各 Pod 的桶相加来计算直方图分位数，得到的是整个集群范围的近似分位数，而不是精确值。由于每个作业恰好只由一个 Pod 处理，这样做是可以接受的，但可能会掩盖某个持续缓慢的 Pod。如需按 Pod 拆分，请加上 `by (le, pod)`。
:::


基于这些指标的告警，请参阅[告警](./alerting.md#batch-gateway-batch-gatewayrules)。

## 第 4 步：启用推理成本指标 {#step-4-enable-inference-cost-metrics}

安装[推理成本跟踪](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/recipes/observability/inferencecost)，以生成 OpenCost 指标以及三个以 `llm_` 为前缀的特殊 Prometheus gauge。这些指标把 Kubernetes 的资源分配成本与 vLLM 的 token 吞吐量结合起来，产生两者单独都无法给出的按模型成本归属。

| 指标 | 标签 | 衡量内容 | 为什么重要 |
|--------|--------|-----------------|----------------|
| `llm_total_hourly_cost` | `model_name`、`model_version`、`namespace`、`cost_basis`、`workload_type` | 归属到该模型的瞬时每小时基础设施成本（美元/小时）——不是累计计数器 | 跟踪每个模型实时的 GPU+CPU+内存支出。使用 `cost_basis="allocation"` 进行内部计费（max(request,usage) × 单价 + 空闲/共享分摊），或使用 `cost_basis="usage"` 进行效率分析（仅实际消耗） |
| `llm_cost_per_million_tokens` | `model_name`、`model_version`、`namespace`、`cost_basis`、`phase`、`allocation_method`、`workload_type` | 每 100 万 token 的基础设施成本 | 主要的单位经济学指标。`phase` 为空表示混合（提示词 + 生成合计），`prompt` 表示仅输入，`generation` 表示仅输出。`allocation_method` 反映成本如何在 prefill 和 decode 阶段之间拆分（见下表） |
| `llm_cache_savings_fraction` | `model_name`、`model_version`、`namespace`、`workload_type` | 由 KV 缓存提供的提示词 token 占比（0–1） | 量化前缀缓存带来的成本下降。禁用缓存、没有缓存命中或缺少 `vllm:prefix_cache_hits_total` 时为零 |

**`llm_cost_per_million_tokens` 的 `allocation_method` 取值：**

| 取值 | 适用情况 |
|-------|----------------|
| `compute_time` | 按 vLLM 的 prefill/decode 时间拆分成本——最准确 |
| `prefix_caching_off` | 基于时间拆分，但前缀缓存已禁用 |
| `multiplier` | 在缺少时间指标时使用固定的 2.5 倍比例 |
| *（空）* | 时间窗内没有处理任何 token，或模型名称关联失败 |

:::note
`workload_type` 标签目前始终为 `inference`。未来可能会增加 `training`、`fine-tuning` 等取值。
:::


这三个指标都从 OpenCost 的 `/metrics` 端点（端口 9003）抓取，并通过 ServiceMonitor 流入 Prometheus。快速检查：

```bash
kubectl port-forward -n llm-d-monitoring svc/opencost 9003:9003
curl -s http://localhost:9003/metrics | grep llm_
```

配置说明请参阅[推理成本跟踪](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/recipes/observability/inferencecost)。

## 第 5 步：查看仪表盘 {#step-5-view-dashboards}

llm-d 为常见的监控场景提供了预置的 Grafana 仪表盘。

### 访问 Grafana {#access-grafana}

:::note
下面的命令使用的是随附安装脚本中的命名空间和服务名称。如果你使用的是现有的 Prometheus 或 Grafana 实例，请相应调整命名空间和服务名称。
:::


```bash
kubectl port-forward -n llm-d-monitoring svc/llmd-grafana 3000:80
# 打开 http://localhost:3000
# 默认登录：admin / admin
```

### 导入仪表盘 {#import-dashboards}

把所有 llm-d 仪表盘加载到 Grafana：

```bash
./guides/recipes/observability/load-llm-d-dashboards.sh
```

确认仪表盘已导入：

```bash
kubectl get configmaps -n llm-d-monitoring -l grafana_dashboard=1
```

预期输出：

```text
NAME                                              DATA   AGE
llm-d-vllm-overview                               1      30s
llm-d-sglang-overview                             1      30s
llm-d-failure-saturation-dashboard                1      30s
llm-d-diagnostic-drilldown-dashboard              1      30s
llm-d-performance-kv-cache                        1      30s
llm-d-pd-coordinator-metrics                      1      30s
llm-d-batch-gateway-apiserver                     1      30s
llm-d-batch-gateway-processor                     1      30s
llm-d-batch-gateway-gc                            1      30s
llm-d-inference-cost                              1      30s
```

也可以从 `guides/recipes/observability/grafana/dashboards/` 手动导入单个仪表盘 JSON 文件：

| 仪表盘 | 展示内容 |
| ----------- | -------------- |
| `llm-d-vllm-overview.json` | vLLM 指标总览 |
| `llm-d-sglang-overview.json` | SGLang 指标总览 |
| `llm-d-tpu-overview.json` | GKE TPU 导出器健康状况和硬件指标；参见 [TPU 方案](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/recipes/observability/tpu/) |
| `llm-d-failure-saturation-dashboard.json` | 故障与饱和指标 |
| `llm-d-diagnostic-drilldown-dashboard.json` | 用于故障排查的详细诊断指标 |
| `llm-d-performance-kv-cache.json` | 包括 KV 缓存利用率在内的性能指标 |
| `llm-d-pd-coordinator-metrics.json` | Prefill/decode 分离指标 |
| `llm-d-batch-gateway-apiserver.json` | 批处理网关 API 服务器的请求速率、延迟和进行中请求 |
| `llm-d-batch-gateway-processor.json` | 批处理网关的作业吞吐、排队等待、工作线程饱和度和 token 用量 |
| `llm-d-batch-gateway-gc.json` | 批处理网关 GC 调谐器的周期、孤儿恢复和错误 |
| `llm-d-inference-cost.json` | 通过 OpenCost 跟踪每 token 和每小时的基础设施成本（需要[推理成本跟踪](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/recipes/observability/inferencecost)） |

三个批处理网关仪表盘只有在部署了[批处理网关指南](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/batch-serving/batch-gateway)时才有用；每个都带有一个 `namespace` 变量，用于选择其运行的命名空间。

## 第 6 步：查询指标 {#step-6-query-metrics}

访问 Prometheus UI：

```bash
kubectl port-forward -n llm-d-monitoring svc/llmd-kube-prometheus-stack-prometheus 9090:9090
# 打开 http://localhost:9090（启用 TLS 时为 https://localhost:9090）
```

## 清理 {#cleanup}

```bash
./guides/recipes/observability/install-prometheus-grafana.sh -u -n llm-d-monitoring
```

## 故障排查 {#troubleshooting}

### 自动扩缩器报告 "http: server gave HTTP response to HTTPS client" {#autoscaler-reports-http-server-gave-http-response-to-https-client}

自动扩缩器配置为使用 HTTPS，但 Prometheus 提供的是 HTTP。请启用 TLS：

```bash
./guides/recipes/observability/install-prometheus-grafana.sh -u
./guides/recipes/observability/install-prometheus-grafana.sh --enable-tls
```

### Prometheus 中没有出现指标 {#metrics-not-appearing-in-prometheus}

1. 检查 PodMonitor 和 ServiceMonitor 是否存在：

   ```bash
   kubectl get podmonitors,servicemonitors -n ${NAMESPACE}
   ```

2. 确认 Prometheus 正在抓取这些目标。打开 `http://localhost:9090/targets`（需先端口转发），检查 vLLM 和 EPP 目标是否显示为 `UP`

3. 确认 Pod 暴露了指标：

   ```bash
   VLLM_POD=$(kubectl get pods -n ${NAMESPACE} -l app=my-model -o jsonpath='{.items[0].metadata.name}')
   kubectl port-forward -n ${NAMESPACE} ${VLLM_POD} 8000:8000
   curl http://localhost:8000/metrics | head -20
   ```

### Grafana 仪表盘显示 "No data" {#grafana-dashboards-show-no-data}

1. 确认 Grafana 数据源指向正确的 Prometheus URL
2. 先确认指标已经流入 Prometheus（使用 Prometheus UI）
3. 如果使用 TLS，确保 Grafana 数据源已配置为 HTTPS，并使用正确的 CA 证书
