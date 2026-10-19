# 分布式追踪

本指南介绍如何在 llm-d 各组件之间启用 [OpenTelemetry](https://opentelemetry.io/) 分布式追踪。

:::note
本指南假定已有一套运行中的 llm-d 部署，包含 InferencePool 和模型服务器。指标和仪表盘请参阅[指标](metrics.md)。
:::


本指南中的命令使用 `${NAMESPACE}` 表示运行 llm-d 工作负载的命名空间：

```bash
export NAMESPACE=<your-llm-d-namespace>
```

## 追踪哪些内容 {#what-gets-traced}

| 组件 | 配置方式 | 追踪的操作 |
|-----------|--------------|-------------------|
| **vLLM**（prefill + decode） | Kustomize：容器参数 + 环境变量 | 推理引擎 span |
| **路由代理**（P/D Sidecar） | Kustomize：容器环境变量 | KV 传输协调 |
| **EPP** | Helm：llm-d 路由器的 `router.tracing:` | 请求路由、端点打分、KV 缓存索引 |

所有组件都通过 OTLP gRPC 把追踪数据导出到 OpenTelemetry Collector，由它过滤噪声（例如抓取 `/metrics` 产生的 span）、批量处理追踪数据，并转发到 Jaeger 等后端。

## 第 1 步：部署 OTel Collector 和 Jaeger {#step-1-deploy-otel-collector-and-jaeger}

把 OTel Collector 和 Jaeger 部署到与 llm-d 工作负载相同的命名空间：

```bash
./guides/recipes/observability/install-otel-collector-jaeger.sh -n ${NAMESPACE}
```

:::note
如果安装了 [OpenTelemetry Operator](https://opentelemetry.io/docs/kubernetes/operator/)，脚本会使用 `OpenTelemetryCollector` CR；否则会部署一个独立的 collector Deployment。
:::


确认组件正在运行：

```bash
kubectl get pods -n ${NAMESPACE} -l app=otel-collector
kubectl get pods -n ${NAMESPACE} -l app=jaeger
```

预期输出：

```text
NAME                              READY   STATUS    RESTARTS   AGE
otel-collector-xxxxxxxxx-xxxxx    1/1     Running   0          30s

NAME                      READY   STATUS    RESTARTS   AGE
jaeger-xxxxxxxxx-xxxxx    1/1     Running   0          30s
```

### 手动部署 {#manual-deployment}

如果你更倾向于直接应用清单：

```bash
# 独立 collector（无 Operator）
kubectl apply -n ${NAMESPACE} -f guides/recipes/observability/tracing/jaeger-all-in-one.yaml \
  -f guides/recipes/observability/tracing/otel-collector.yaml

# 或者在已安装 OTel Operator 的情况下
kubectl apply -n ${NAMESPACE} -f guides/recipes/observability/tracing/jaeger-all-in-one.yaml \
  -f guides/recipes/observability/tracing/otel-collector-operator.yaml
```

使用上面相同的 `kubectl get pods` 命令进行验证。

## 第 2 步：在模型服务器和路由代理上启用追踪 {#step-2-enable-tracing-on-the-model-server-and-routing-proxy}

模型服务器通过 kustomize 部署。下面的示例使用 vLLM；SGLang 以及其他支持 OpenTelemetry 的模型服务器使用相同的 `OTEL_*` 环境变量——请把 `OTEL_SERVICE_NAME` 设置为与你的引擎和角色相符的名称。把引擎的追踪参数加到其启动命令中，并把 OTEL 环境变量加到容器上：

```yaml
# 加到模型服务器的启动命令中（以 vLLM 为例）：
#   --otlp-traces-endpoint http://otel-collector:4317
#   --collect-detailed-traces all

# 加到容器环境变量中（适用于任何支持 OpenTelemetry 的引擎）：
env:
- name: OTEL_SERVICE_NAME
  value: "vllm-decode"  # 按引擎/角色命名，例如 vllm-decode、vllm-prefill、sglang-decode
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: "http://otel-collector:4317"
- name: OTEL_TRACES_SAMPLER
  value: "parentbased_traceidratio"
- name: OTEL_TRACES_SAMPLER_ARG
  value: "1.0"
```

## 第 3 步：在 EPP 上启用追踪 {#step-3-enable-tracing-on-epp}

把追踪配置加入 llm-d 路由器的配置值：

```yaml
# 在路由器的 values 文件中
router:
  tracing:
    enabled: true
    otelExporterEndpoint: "http://otel-collector:4317"
    sampling:
      sampler: "parentbased_traceidratio"
      samplerArg: "1.0"
```

## 第 4 步：查看追踪 {#step-4-view-traces}

访问 Jaeger UI：

```bash
kubectl port-forward -n ${NAMESPACE} svc/jaeger-collector 16686:16686
# 打开 http://localhost:16686
```

验证追踪数据是否在流转：

1. 通过 llm-d 发送一个推理请求
2. 打开 Jaeger UI
3. 选择一个服务（例如 `vllm-decode`、`llm-d-router/epp`）
4. 点击 **Find Traces**

你应该能看到包含多个 span、覆盖请求生命周期的追踪。也可以通过 Jaeger API 验证：

```bash
curl -s http://localhost:16686/api/services | jq '.data'
```

预期输出：

```json
[
  "vllm-decode",
  "llm-d-router/epp"
]
```

如果只看到通用的 `GET` span，请检查：

- vLLM 容器参数中是否包含 `--collect-detailed-traces all`
- EPP 镜像是否包含追踪埋点

## 生产环境建议 {#production-recommendations}

- **采样**：把 `samplerArg` 设为 `"0.1"`（10%）或更低，以降低开销
- **Collector**：使用 collector 对追踪数据进行批处理、过滤，并路由到持久化后端
- **后端**：使用配合 Elasticsearch/Cassandra 存储的 Jaeger，或使用 Grafana Tempo 实现长期保留
- **服务名称**：为每个容器设置 `OTEL_SERVICE_NAME`（例如 `vllm-decode-prod`、`epp-us-east`），以区分不同的集群和环境

## 环境变量参考 {#environment-variable-reference}

启用追踪后，vLLM 和路由代理容器上会设置以下环境变量：

| 变量 | 说明 |
|----------|-------------|
| `OTEL_SERVICE_NAME` | 服务标识（例如 `vllm-decode`、`routing-proxy`） |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Collector 端点（`http://otel-collector:4317`） |
| `OTEL_TRACES_SAMPLER` | 采样器类型（例如 `parentbased_traceidratio`） |
| `OTEL_TRACES_SAMPLER_ARG` | 采样比例（`1.0` = 100%，`0.1` = 10%） |

## 清理 {#cleanup}

```bash
./guides/recipes/observability/install-otel-collector-jaeger.sh -u -n ${NAMESPACE}
```
