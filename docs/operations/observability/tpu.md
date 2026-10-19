# GKE TPU 可观测性

本参考用于解读 GKE TPU 设备插件的指标，并排查数据缺失问题。请按照 [TPU 方案](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/recipes/observability/tpu/)启用抓取并加载仪表盘。本参考针对的是下文所述的导出器接口。在依赖某个硬件面板之前，请先检查导出器的输出。

## 指标接口 {#metric-interface}

本参考针对的是 GKE 设备插件的 `/metrics` 接口，而不是 Ray 的 `ray_tpu_*` 指标或单独的 libtpu 导出器。它使用原始 gauge，不使用记录规则、特定于模型的容量假设或缺失值默认值。

| 指标 | 单位 | 含义 | 可用性依据 |
| --- | --- | --- | --- |
| `tensorcore_utilization` | 百分比，0–100 | TensorCore 利用率 | 已发布的 GKE v6e 样例 |
| `memory_bandwidth_utilization` | 百分比，0–100 | HBM 带宽利用率，而非容量使用率 | 已发布的 GKE v6e 样例 |
| `duty_cycle` | 百分比，0–100 | 处于活跃处理状态的时间占比 | Ray 解析器；可选的运行时指标 |
| `memory_used` | 字节 | 已使用的加速器内存 | Ray 解析器；可选的运行时指标 |
| `memory_total` | 字节 | 可分配的加速器内存 | Ray 解析器；可选的运行时指标 |

硬件查询会选择 `make="cloud-tpu"`，并使用 `model`、`tpu_topology` 和 `accelerator_id` 标签。`model` 标签表示 TPU 类型，而不是所部署的 LLM；仪表盘变量命名为 `tpu_model`，就是为了明确这一区别。

### 标签范围 {#label-scope}

| 标签 | 来源与用途 |
| --- | --- |
| `job` | Prometheus 抓取标识；由于 PodMonitor 没有设置 `jobLabel`，默认为 `kube-system/tpu-metrics-exporter`。仪表盘以精确匹配选择一个 job |
| `instance` | Prometheus 抓取目标；即使多个导出器报告相同的加速器 ID，也能把它们区分开 |
| `make` | 导出器的硬件标签；查询要求为 `cloud-tpu`，从而排除所选 job 中其他厂商的加速器 |
| `model`、`tpu_topology`、`accelerator_id` | 导出器的硬件标签，保持原样，不重命名，也不与模型服务器指标关联 |
| `namespace`、`pod`、`container` | 在方案默认的 `honorLabels: false` 行为下，冲突的导出器标签会变成 `exported_namespace`、`exported_pod` 和 `exported_container`；原始名称标识的是抓取目标 |

PodMonitor 的 Kubernetes 元数据标签用于监控发现；它们不会被自动复制到指标样本上。工作负载归属必须使用被抓取序列上实际存在的标签。特别地，抓取目标的 `namespace="kube-system"` 并不标识推理工作负载。该仪表盘不按工作负载命名空间过滤，也不跨工作负载聚合。

job 下拉框包含所有抓取 job，因此即使失败的导出器没有输出任何硬件指标，也仍然可以被选中。请选择 TPU 导出器对应的 job。硬件查询还要求 `make="cloud-tpu"`；抓取健康查询只使用 job 和 instance，因为 `up` 不带有导出器的硬件标签。

### 接口来源 {#interface-sources}

该接口的来源是 [Ray 的 GKE TPU 解析器](https://github.com/ray-project/ray/blob/be4889928d3a396d7a1476d1bac3288dac72f9ab/python/ray/dashboard/modules/reporter/reporter_agent.py)以及一个[已发布的 GKE v6e 导出器样例](https://github.com/ray-project/ray/issues/57829)。该样例展示了利用率指标；解析器还处理运行时的 duty-cycle 和内存指标，并明确指出某些 TPU 类型不会输出运行时指标。这些来源并不能证明每个 GKE 或 TPU 版本都支持这些指标。为本参考没有进行新的 GKE/TPU 硬件验证。

TPU 型号和拓扑只是过滤条件，而不是兼容性矩阵。只要导出器提供上述接口，就可以在不同 TPU 型号上使用相同的查询；更换 vLLM 或 llm-d 镜像并不能决定 GKE 导出器提供哪些硬件指标。在升级 GKE 运行时或导出器之后，请重新验证该接口。

单独的 `tensorcore_utilization_node` 和 `memory_bandwidth_utilization_node` 序列不会与关联到工作负载的序列相加：那样做可能会对同一硬件重复计数。主机指标和运行时指标也可能使用不同的芯片编号，因此面板显示原始的加速器 ID，而不会跨指标族进行关联。

## 检查导出器 {#check-the-exporter}

在解读硬件面板之前，请先检查实际的导出器：

```bash
kubectl get pods -n kube-system -l k8s-app=tpu-device-plugin -o wide
# 用上面输出中的某个 Pod 名称替换；保持该命令运行。
kubectl port-forward -n kube-system pod/<exporter-pod> 2112:2112
```

在另一个终端中：

```bash
curl --fail --silent --show-error http://localhost:2112/metrics \
  | grep -E '^(# (HELP|TYPE) )?(tensorcore_utilization|memory_bandwidth_utilization|duty_cycle|memory_used|memory_total)([ {]|$)'
```

把指标名称、单位和标签与上表进行比较。验证关联到工作负载的指标时，请使用一个处于活跃状态的 TPU 工作负载。在 Prometheus 中运行以下检查，并替换为你实际的抓取 job：

```promql
up{job="kube-system/tpu-metrics-exporter"}
```

值为 1 表示抓取成功。要查看每个 instance 上有哪些仪表盘指标可用（不应用硬件标签过滤）：

```promql
count by (__name__, instance) (
  {job="kube-system/tpu-metrics-exporter",__name__=~"tensorcore_utilization|memory_bandwidth_utilization|duty_cycle|memory_used|memory_total"}
)
```

这里的计数表示导出的序列数，而不是设备数或利用率。缺失的指标不会有对应的行。然后查看一条原始序列，检查其标签和取值：

```promql
tensorcore_utilization{job="kube-system/tpu-metrics-exporter"}
```

如果这条查询有数据而仪表盘没有，请检查 `make="cloud-tpu"`，并把 instance、model 和 topology 过滤器重置为 **All**。选择 **All** 时，缺少 model/topology 标签不会把序列排除在外。

| 现象 | 需要检查的内容 |
| --- | --- |
| 没有抓取健康序列 | 确认 Prometheus 已发现 PodMonitor 及其命名空间；检查所选的数据源、job 和 instance |
| 抓取健康值为 0 | 检查抓取目标的错误、导出器可用性、端口和网络访问 |
| 抓取健康值为 1，但硬件面板为空 | 把 `/metrics` 与上述接口进行比较；把 model/topology 过滤器重置为 All，并检查运行时是否为活跃的工作负载输出了指标 |
| 只有 duty-cycle 或内存面板为空 | 运行时可能不输出这些指标；抓取成功并不意味着所有硬件指标都可用 |
| 名称、标签或单位不同 | 确认语义等价后，基于仪表盘副本进行改造；如果单位或范围不同，仅修改名称是不够的 |

请让缺失的指标保持为 **No data**。不要用零替代，也不要据此推断设备处于空闲状态。由于本参考没有确定 ICI、PCIe 和 VPU 的导出器接口，因此不包含这些面板。报告结果时，请附上 GKE 版本、TPU 类型、导出器镜像（如有）以及一份脱敏的指标样例，以便评估兼容性。
