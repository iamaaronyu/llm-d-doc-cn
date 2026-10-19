# 可观测性部署

本页介绍如何为 llm-d 部署搭建 Prometheus、Grafana 和分布式追踪。所有指南都会引用本页——只需配置一次，即可在每份指南中使用。

:::note
本页中的命令使用 `${NAMESPACE}` 表示运行 llm-d 工作负载的命名空间。开始之前请先设置它：

```bash
export NAMESPACE=<your-llm-d-namespace>
```
:::


## 第 1 步：安装 Prometheus 和 Grafana {#step-1-install-prometheus-and-grafana}

如果集群中已经运行着 Prometheus，请跳过这一步。

```bash
# 把 Prometheus + Grafana 安装到 llm-d-monitoring 命名空间
./guides/recipes/observability/install-prometheus-grafana.sh
```

如需 HTTPS/TLS（WVA 等自动扩缩器需要）：

```bash
./guides/recipes/observability/install-prometheus-grafana.sh --enable-tls
```

验证安装：

```bash
kubectl get pods -n llm-d-monitoring
```

预期输出：

```text
NAME                                                     READY   STATUS    RESTARTS   AGE
alertmanager-llmd-kube-prometheus-stack-alertmanager-0    2/2     Running   0          30s
llmd-grafana-xxxxxxxxx-xxxxx                             3/3     Running   0          30s
prometheus-llmd-kube-prometheus-stack-prometheus-0        2/2     Running   0          30s
```

### 各平台说明 {#platform-specific-notes}

#### OpenShift

OpenShift 通过用户工作负载监控（User Workload Monitoring）提供内置的 Prometheus 技术栈。请启用它，而不是另外安装一套 Prometheus：

- 参阅 [OpenShift 监控文档](https://docs.redhat.com/en/documentation/monitoring_stack_for_red_hat_openshift/4.18/html-single/configuring_user_workload_monitoring/index)启用用户工作负载监控
- Prometheus 端点：`https://thanos-querier.openshift-monitoring.svc.cluster.local:9091`

#### GKE

GKE 集群默认包含 [Google Managed Prometheus（GMP）](https://cloud.google.com/stackdriver/docs/managed-prometheus)。GKE 还提供内置的[推理网关仪表盘](https://cloud.google.com/kubernetes-engine/docs/how-to/customize-gke-inference-gateway-configurations#inference-gateway-dashboard)。

要把 GMP 用作 Grafana 数据源，请参照 [GMP 与 Grafana 集成指南](https://docs.cloud.google.com/stackdriver/docs/managed-prometheus/query#ui-grafana)。

## 手动配置 ServiceMonitor（兜底方案） {#manual-servicemonitor-setup-fallback}

:::note
**推荐的方式是使用 llm-d Helm Chart**，在包含 `monitoring.values.yaml` 时它会自动创建 ServiceMonitor。如果你是这样部署的，请跳过本节。
:::


**仅在**工作负载不是通过 llm-d Helm Chart 部署时（例如 CRD、KServe 或 RHAII），才把这种手动配置作为兜底方案——这些情况下不会自动创建 ServiceMonitor，需要按下面的方式手动创建。

### 查找 Service 的标签 {#find-your-service-labels}

ServiceMonitor 的选择器必须（MUST）与 Service 的标签完全一致：

```bash
# 查找 EPP/路由器的 Service
kubectl get svc -n ${NAMESPACE} --show-labels

# 查看某个 Service 的完整标签
kubectl get svc -n ${NAMESPACE} <epp-service-name> -o yaml
```

记下 `app.kubernetes.io/component` 和 `app.kubernetes.io/name` 的确切取值。

### 创建 ServiceMonitor {#create-servicemonitors}

**针对 EPP：**

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: <epp-servicemonitor-name>
  namespace: ${NAMESPACE}
spec:
  selector:
    matchLabels:
      app.kubernetes.io/component: <epp-component>
      app.kubernetes.io/name: <epp-name>
  namespaceSelector:
    matchNames:
      - ${NAMESPACE}
  endpoints:
    - port: metrics
      path: /metrics
      interval: 10s
      scheme: http
      bearerTokenFile: /var/run/secrets/kubernetes.io/serviceaccount/token
```

**针对 vLLM：**

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: <vllm-servicemonitor-name>
  namespace: ${NAMESPACE}
spec:
  selector:
    matchLabels:
      app.kubernetes.io/component: <vllm-component>
      app.kubernetes.io/name: <vllm-name>
  namespaceSelector:
    matchNames:
      - ${NAMESPACE}
  endpoints:
    - port: https
      path: /metrics
      interval: 10s
      scheme: https
      tlsConfig:
        insecureSkipVerify: true
```

应用：

```bash
kubectl apply -f servicemonitor-epp.yaml
kubectl apply -f servicemonitor-vllm.yaml
```

### 验证 {#verify}

```bash
kubectl port-forward -n llm-d-monitoring svc/llmd-kube-prometheus-stack-prometheus 9090:9090
curl -sk 'https://localhost:9090/api/v1/targets' | jq '.data.activeTargets[] | select(.labels.namespace=="'${NAMESPACE}'") | {job: .labels.job, health: .health}'
```

各抓取目标应显示 `"health": "up"`。然后进入第 2 步配置仪表盘。

## 第 2 步：加载 Grafana 仪表盘 {#step-2-load-grafana-dashboards}

```bash
./guides/recipes/observability/load-llm-d-dashboards.sh
```

确认仪表盘已导入：

```bash
kubectl get configmaps -n llm-d-monitoring -l grafana_dashboard=1
```

然后访问 Grafana：

```bash
kubectl port-forward -n llm-d-monitoring svc/llmd-grafana 3000:80
# 打开 http://localhost:3000（登录：admin / admin）
```

可用的仪表盘：

| 仪表盘 | 展示内容 |
| ----------- | -------------- |
| `llm-d-vllm-overview` | vLLM 指标总览 |
| `llm-d-sglang-overview` | SGLang 指标总览 |
| `llm-d-tpu-overview` | GKE TPU 导出器健康状况和硬件指标；需要 [TPU 方案](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/recipes/observability/tpu/) |
| `llm-d-failure-saturation-dashboard` | 关键的故障与饱和指标 |
| `llm-d-diagnostic-drilldown-dashboard` | 用于故障排查的详细诊断指标 |
| `llm-d-performance-kv-cache` | KV 缓存利用率与性能 |
| `llm-d-pd-coordinator-metrics` | Prefill/decode 分离指标 |
| `llm-d-inference-gateway` | 推理网关（EPP）指标：推理资源池、推理目标和流量控制 |

## 第 3 步：安装分布式追踪（可选） {#step-3-install-distributed-tracing-optional}

把 OTel Collector 和 Jaeger 部署到与 llm-d 工作负载相同的命名空间：

```bash
./guides/recipes/observability/install-otel-collector-jaeger.sh -n ${NAMESPACE}
```

然后访问 Jaeger UI：

```bash
kubectl port-forward -n ${NAMESPACE} svc/jaeger-collector 16686:16686
# 打开 http://localhost:16686
```

关于在 vLLM、路由代理和 EPP 之间配置完整追踪的方法，请参阅[分布式追踪](./tracing.md)。

## 清理 {#cleanup}

```bash
# 移除 Prometheus 和 Grafana
./guides/recipes/observability/install-prometheus-grafana.sh -u -n llm-d-monitoring

# 移除 OTel Collector 和 Jaeger
./guides/recipes/observability/install-otel-collector-jaeger.sh -u -n ${NAMESPACE}
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

2. 打开 `http://localhost:9090/targets`（需先对 Prometheus 做端口转发），检查 vLLM 和 EPP 目标是否显示为 `UP`

3. 确认 Pod 暴露了指标：

   ```bash
   VLLM_POD=$(kubectl get pods -n ${NAMESPACE} -l app=my-model -o jsonpath='{.items[0].metadata.name}')
   kubectl port-forward -n ${NAMESPACE} ${VLLM_POD} 8000:8000
   curl http://localhost:8000/metrics | head -20
   ```

### Grafana 仪表盘显示 "No data" {#grafana-dashboards-show-no-data}

1. 确认 Grafana 数据源指向正确的 Prometheus URL
2. 先确认指标已经流入 Prometheus
3. 如果使用 TLS，确保 Grafana 数据源已配置为 HTTPS，并使用正确的 CA 证书
