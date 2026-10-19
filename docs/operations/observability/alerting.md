# 告警

本页介绍 EPP（端点选择器）和批处理网关的默认 Prometheus 告警规则集。关于 Prometheus 和 Grafana 的安装，请先参阅[可观测性部署](./setup.md)；这些告警所依据的指标，请参阅[指标](./metrics.md)。

这些规则以 [`PrometheusRule`](https://prometheus-operator.dev/docs/getting-started/design/#prometheusrule) 自定义资源的形式提供，因此需要 Prometheus Operator（[部署指南](./setup.md)安装的 kube-prometheus-stack 中已包含）。

:::note
本页中的命令使用 `${NAMESPACE}` 表示运行 llm-d 工作负载的命名空间。开始之前请先设置它：

```bash
export NAMESPACE=<your-llm-d-namespace>
```
:::


## 前提条件 {#prerequisites}

- 一套带有 InferencePool 的运行中 llm-d 部署——如有需要，请参阅[快速开始](../../getting-started/quickstart.md)
- 已安装 Prometheus 和 Prometheus Operator——参见[可观测性部署](./setup.md)
- EPP 指标正在被抓取——参见[指标](./metrics.md)（确认 `epp-servicemonitor` ServiceMonitor 存在）

## 第 1 步：应用告警规则 {#step-1-apply-the-alerting-rules}

应用随附的 `PrometheusRule`：

```bash
kubectl apply -n ${NAMESPACE} -f guides/recipes/observability/alerts/epp-alerting-rules.yaml
```

:::note
随附的 [`install-prometheus-grafana.sh`](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/recipes/observability/install-prometheus-grafana.sh) 会放开 Prometheus 的 `ruleSelector`，使任何 `PrometheusRule` 都能被发现（集中模式）。如果以独立/限定范围模式运行安装器，Prometheus 只会选择带有 `monitoring-ns: ${NAMESPACE}` 标签、且位于带有相同标签的命名空间中的规则——请为 `PrometheusRule`（及其命名空间）加上该标签，使其与你的 `ServiceMonitor` 匹配。如果你使用自己的 Prometheus，请确保其 `ruleSelector` 能匹配该资源上的 `app: epp-metrics` 标签。
:::


## 第 2 步：验证 {#step-2-verify}

确认规则已创建：

```bash
kubectl get prometheusrules -n ${NAMESPACE}
```

预期输出：

```text
NAME                 AGE
epp-alerting-rules   10s
```

然后打开 Prometheus UI，在 **Status → Rule Health** 下检查规则是否已加载（或在端口转发后打开 `http://localhost:9090/rules`——参见[指标](./metrics.md#step-6-query-metrics)）。你应该能看到 `epp.availability` 和 `epp.selfhealth` 两个规则组。

## 告警参考 {#alert-reference}

所有指标名称都使用当前的 `llm_d_epp_*` 前缀。阈值和 `for:` 时间窗都是偏保守的默认值——请根据你的流量特征进行调整（参见[自定义](#customization)）。

### 可用性与错误（`epp.availability`） {#availability-and-errors-eppavailability}

| 告警 | 严重级别 | 触发条件 | 为什么重要 |
|-------|----------|-----------|----------------|
| `EPPHighErrorRatio` | warning | 错误率 > 5% 持续 10 分钟 | 后端或路由故障正在影响相当一部分请求 |
| `EPPCriticalErrorRatio` | critical | 错误率 > 20% 持续 5 分钟 | 推理路径很可能已经中断，而不只是性能下降 |
| `EPPNoReadyEndpoints` | critical | `llm_d_epp_ready_endpoints == 0` 持续 2 分钟 | 资源池中没有可路由的端点——每个请求都会失败 |
| `EPPMetricsAbsent` | critical | `absent(llm_d_epp_ready_endpoints)` 持续 5 分钟 | 粗粒度的集群级信号：所有资源池都没有 EPP 指标——所有 EPP 都已宕机或抓取完全停止（一种无声的可观测性缺口） |

错误率告警对 `0/0` 是安全的：没有流量时表达式不产生值，告警保持静默。在流量非常低的工作负载上，启动阶段可能会出现告警抖动——可以用 `and sum(rate(llm_d_epp_request_total[5m])) > N` 加一个请求速率下限。

:::note
`EPPMetricsAbsent` 使用 `absent()`，只有在完全*不存在*任何 `llm_d_epp_ready_endpoints` 序列时才会触发。在多资源池部署中，某个资源池的 EPP 宕机时，其他资源池可能仍在上报——宕机资源池的序列会消失而不是报告 `0`，因此这条告警和 `EPPNoReadyEndpoints` 都不会为它触发。如需按资源池覆盖，可以针对“最近存在但已消失”的序列告警：

```promql
llm_d_epp_ready_endpoints offset 15m unless llm_d_epp_ready_endpoints
```

它会为每个消失的资源池触发一次，代价是需要一个固定的回溯窗口（被有意移除的资源池在偏移时间过去之前也会触发）。
:::


### EPP 自身健康（`epp.selfhealth`） {#epp-self-health-eppselfhealth}

| 告警 | 严重级别 | 触发条件 | 为什么重要 |
|-------|----------|-----------|----------------|
| `EPPDataLayerPollErrors` | warning | `llm_d_epp_datalayer_poll_errors_total` 持续增长 10 分钟 | 某个数据来源轮询失败——调度可能正在基于过期的端点状态运行 |
| `EPPDataLayerExtractErrors` | warning | `llm_d_epp_datalayer_extract_errors_total` 持续增长 10 分钟 | 某个数据提取器失败——调度可能正在基于过期状态运行 |
| `EPPExtProcStreamErrors` | warning | `llm_d_epp_extproc_streams_total{code!~"OK\|Canceled"}` 持续增长 10 分钟 | Envoy↔EPP 之间的 `ext_proc` 流正在异常终止 |

:::note
`EPPExtProcStreamErrors` 依赖通过 EPP 的 `--enable-grpc-stream-metrics` 参数启用的可选指标。未设置该参数时，这些序列不存在，告警永远不会触发。匹配器排除了 `OK` 和 `Canceled`（正常的客户端断开）——请根据你的环境进行调整。
:::


### 批处理网关（`batch-gateway.rules`） {#batch-gateway-batch-gatewayrules}

这些告警针对的是批处理网关的处理器和 GC 调谐器，而不是请求路径，因此以单独的 `PrometheusRule` 提供，只有在部署了[批处理网关指南](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/batch-serving/batch-gateway)时才相关。

```bash
kubectl apply -n ${NAMESPACE} -f guides/recipes/observability/alerts/batch-gateway-alerting-rules.yaml
kubectl get prometheusrules -n ${NAMESPACE}
```

随后你应该能在 Prometheus UI 的 **Status → Rule Health** 下看到 `batch-gateway.rules` 规则组。

:::info
该文件中的每个表达式都限定在 `namespace="batch-gateway"`，这是批处理网关指南的部署命名空间。批处理网关的指标名称没有前缀且比较通用（`jobs_processed_total`、`active_workers`），因此不加限定的规则可能会采集到无关的工作负载。如果你部署到了其他命名空间，请修改匹配器使其一致——把 `PrometheusRule` 应用到你的命名空间**并不会**限定其查询范围。如果你使用自己的 Prometheus，其 `ruleSelector` 必须匹配该资源的标签 `app: batch-gateway-metrics`（而不是 EPP 规则专用的 `app: epp-metrics`）。
:::


| 告警 | 严重级别 | 触发条件 | 为什么重要 |
|-------|----------|-----------|----------------|
| `BatchGatewayHighQueueWait` | warning | `job_queue_wait_duration_seconds` 的 p95 > 300 秒持续 15 分钟 | 作业在优先级队列中堆积的速度超过了工作线程的消化速度 |
| `BatchGatewayHighJobFailureRate` | warning | `jobs_processed_total` 中失败占比 > 10% 持续 10 分钟 | 作业执行的失败率已经高到用户会察觉的程度 |
| `BatchGatewayExpiredJobsDetected` | warning | `jobs_processed_total` 中过期占比 > 3% 持续 10 分钟 | 作业在执行之前就已过期——这是容量或完成时间窗的问题，而不是代码故障 |
| `BatchGatewayWorkersSaturated` | warning | `active_workers / total_workers` > 90% 持续 15 分钟 | 工作池成为瓶颈；请提高 `NumWorkers` 或增加副本 |
| `BatchReconcilerErrors` | warning | `batch_reconciler_errors_total` 在 65 分钟内有增长 | GC 孤儿调谐器在失败，因此孤儿作业没有被恢复 |

两条比率告警在分母上使用了 `clamp_min`，因此在没有作业处理时保持静默，而不会出现除以零。

`BatchReconcilerErrors` 使用 65 分钟窗口上的 `increase()` 而不是 `rate()`：调谐器默认每 60 分钟运行一次，每个周期最多递增一次计数器，对于 `rate()` 阈值来说太稀疏了。如果你在 GC 配置中缩短了 `reconciler.interval`，请相应缩短该窗口——窗口短于间隔可能会漏掉每周期一次的失败，而窗口过长则会让告警在错误过期后仍持续触发。

## 自定义 {#customization}

这些规则只是一个起点，而不是经过调优的策略。常见的调整包括：

- **阈值和持续时间**——针对每条告警修改 `expr` 中的比较值（`> 0.05`）和 `for:` 时间窗，以符合你的 SLO 和对噪声的容忍度。
- **路由**——`severity: warning|critical` 标签是 Alertmanager 路由的挂钩（例如 `critical` 发出呼叫，`warning` 发到 Slack）。请在 Alertmanager 配置中设置路由。
- **范围**——要按资源池或按模型告警，可以在错误率表达式中加入 `by (...)` 子句，使用 `name` 或 `model_name` 等标签。

更多可以升级为告警的查询（例如延迟 SLO 和流量控制饱和度），请参阅 [PromQL 参考](./promql.md)。

## 清理 {#cleanup}

```bash
kubectl delete -n ${NAMESPACE} -f guides/recipes/observability/alerts/epp-alerting-rules.yaml
kubectl delete -n ${NAMESPACE} -f guides/recipes/observability/alerts/batch-gateway-alerting-rules.yaml
```

## 故障排查 {#troubleshooting}

### 规则没有出现在 Prometheus UI 中 {#rules-dont-appear-in-the-prometheus-ui}

1. 确认资源存在：`kubectl get prometheusrules -n ${NAMESPACE}`。
2. 确认 Prometheus 的 `ruleSelector` 与规则的标签匹配。在集中模式下，随附的安装器会设置 `ruleSelectorNilUsesHelmValues: false` 并放开 `ruleSelector`；在限定范围模式下，请添加 `monitoring-ns` 标签（参见[第 1 步](#step-1-apply-the-alerting-rules)）。
3. 查看 Prometheus Operator 日志中是否有规则被拒绝的错误：`kubectl logs -n llm-d-monitoring -l app.kubernetes.io/name=prometheus-operator`。

### 某条告警从不触发 {#an-alert-never-fires}

- `EPPExtProcStreamErrors` 需要 EPP 的 `--enable-grpc-stream-metrics` 参数（见上文说明）。
- 错误率告警只有在有流量时才会求值——参见上文关于 `0/0` 安全的说明。
- 自身健康计数器只有在第一次出错后才会产生序列。
