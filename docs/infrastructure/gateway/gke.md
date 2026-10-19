# GKE

本指南介绍如何以 [GKE Gateway](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/about-gke-inference-gateway) 作为推理网关部署 llm-d。完成后，推理请求将由 GKE 管理的 `Gateway` 经由 llm-d EPP 转发到你的模型服务器。

:::note
本指南假定你已熟悉 [Gateway API](https://gateway-api.sigs.k8s.io/) 和 llm-d。
:::


## 前提条件 {#prerequisites}

1. 在部署某个成熟路径指南的过程中，应已设置环境变量 `${GUIDE_NAME}`、`${MODEL_NAME}` 和 `${NAMESPACE}`。
2. 你已核对 llm-d 仓库全局 `env.sh` 文件中的版本，并 source 了该文件：

   ```bash
   export REPO_ROOT=$(realpath $(git rev-parse --show-toplevel))
   source ${REPO_ROOT}/guides/env.sh
   ```

3. 应已执行 [GKE Inference Gateway 部署文档](https://cloud.google.com/kubernetes-engine/docs/how-to/deploy-gke-inference-gateway)中的以下步骤：

* [核对前提条件](https://cloud.google.com/kubernetes-engine/docs/how-to/deploy-gke-inference-gateway#before-you-begin)
* [配置仅代理子网](https://cloud.google.com/kubernetes-engine/docs/how-to/deploying-gateways#configure_a_proxy-only_subnet)
* [在集群中启用 Gateway API](https://cloud.google.com/kubernetes-engine/docs/how-to/deploying-gateways#enable-gateway)
* [验证集群](https://cloud.google.com/kubernetes-engine/docs/how-to/deploying-gateways#verify-internal)

## 第 1 步：安装 Gateway API 和 Gateway API Inference Extension CRD {#step-1-install-gateway-api-and-gateway-api-inference-extension-crds}

:::note
在 GKE `1.34.0-gke.1626000` 或更新版本上，GKE 会自动安装 Gateway API 和 Gateway API Inference Extension 的所有 GA CRD。如果使用该版本或更新版本，请直接跳到第 2 步。
:::


对于早于 `1.34.0-gke.1626000` 的 GKE 版本，请手动安装 CRD：

```bash
# GAIE_URL 由 ${REPO_ROOT}/guides/env.sh 根据 GAIE_VERSION 自动计算
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api-inference-extension/${GAIE_URL}/v1-manifests.yaml
```

确认这些 API 可用：

```bash
kubectl api-resources --api-group=gateway.networking.k8s.io
kubectl api-resources --api-group=inference.networking.k8s.io
```

## 第 2 步：部署 Gateway {#step-2-deploy-the-gateway}

GKE 支持两种应用负载均衡器。请根据网络需求选择其一：

### 区域级外部应用负载均衡器 {#regional-external-application-load-balancer}

适用于需要从 VPC 外部访问的、面向互联网的工作负载：

```bash
LLM_D_VERSION=main  # 使用 'main' 获取最新版本，或使用发布标签，如 'v0.7.0'
GATEWAY_CLASS=gke-l7-regional-external-managed
kubectl apply -n ${NAMESPACE} -k "https://github.com/llm-d/llm-d/guides/recipes/gateway/${GATEWAY_CLASS}?ref=${LLM_D_VERSION}"
```

### 区域级内部应用负载均衡器 {#regional-internal-application-load-balancer}

适用于只能在 VPC 内部访问的私有工作负载：

```bash
LLM_D_VERSION=main  # 使用 'main' 获取最新版本，或使用发布标签，如 'v0.7.0'
GATEWAY_CLASS=gke-l7-rilb
kubectl apply -n ${NAMESPACE} -k "https://github.com/llm-d/llm-d/guides/recipes/gateway/${GATEWAY_CLASS}?ref=${LLM_D_VERSION}"
```

## 第 3 步：验证 Gateway {#step-3-verify-the-gateway}

确认 `Gateway` 已就绪（programmed）：

```bash
kubectl get gateway -n ${NAMESPACE} llm-d-inference-gateway
```

预期输出：

```text
NAME                      CLASS                              ADDRESS         PROGRAMMED   AGE
llm-d-inference-gateway   gke-l7-regional-external-managed   xx.xx.xx.xx     True         30s
```

等待 `PROGRAMMED` 显示为 `True` 后再继续。

## 第 4 步：部署模型服务工作负载 {#step-4-deploy-a-model-serving-workload}

在通过 Gateway 发送推理请求之前，必须先部署模型服务器（例如 vLLM）、一个 `InferencePool`，以及把 Gateway 连接到该资源池的 `HTTPRoute`。你可以使用标准基线进行部署，也可以启用高可用。

### 方案 A：标准部署（成熟路径） {#option-a-standard-deployment-well-lit-path}

在启用 GKE Gateway 提供方的情况下部署某个成熟路径指南：

1. **以网关模式部署 llm-d 路由器：**

```bash
export PROVIDER_NAME=gke
helm install ${GUIDE_NAME} \
  ${ROUTER_GATEWAY_CHART} \
  -f ${ROUTER_BASE_VALUES} \
  ${MONITORING_VALUES} \
  -f ${ROUTER_VALUES} \
  --set provider.name=${PROVIDER_NAME} \
  --set httpRoute.create=true \
  --set httpRoute.inferenceGatewayName=llm-d-inference-gateway \
  -n ${NAMESPACE} --version ${ROUTER_CHART_VERSION}
```

2. **使用 GKE 覆盖层部署模型服务器：**

```bash
export ACCELERATOR_TYPE=gpu # 可选值：gpu、amd、xpu、hpu、tpu/v6、tpu/v7、cpu
export MODEL_SERVER=vllm    # 可选值：vllm、sglang、trtllm
kubectl apply -n ${NAMESPACE} -k ${REPO_ROOT}/guides/${GUIDE_NAME}/modelserver/${ACCELERATOR_TYPE}/${MODEL_SERVER}/gke/
```

### 方案 B：使用首选后端实现高可用 {#option-b-high-availability-with-preferred-backends}

结合 [GKE 首选后端（Preferred Backends）](https://docs.cloud.google.com/load-balancing/docs/service-lb-policy#preferred-backends)部署端点选择器（EPP），可以实现由 Cloud Load Balancing 支撑的主备路由拓扑。稳态下的 ext_proc 流量只路由到主 EPP 副本（epp-0），以集中保存 KV 缓存追踪和请求状态。如果 epp-0 变得不健康，Cloud Load Balancing 会把流量切换到热备副本（epp-1），而 InferencePool 的 fail-open 模式则作为防止请求被丢弃的额外安全网。

#### 主要优势 {#key-benefits}
* **状态一致性**：把稳态下 100% 的 `ext_proc` 流量导向主 EPP 实例（`epp-0`），保留 KV 缓存状态和请求调度上下文。
* **零停机故障切换**：如果主 EPP Pod 崩溃或进行维护，Cloud Load Balancer 会通过主动 gRPC 健康检查发现故障，并立即把流量路由到热备副本（`epp-1`）。
* **Fail-Open 弹性**：配合 `InferencePool` 上的 `failureMode: FailOpen`，短暂的路由抖动会绕过 EPP，直接转发给模型服务器，而不会丢弃用户请求。

#### 1. **部署启用首选后端的 llm-d 路由器：** {#1-deploy-the-llm-d-router-with-preferred-backends-enabled}

:::note
启用首选后端后，Chart 会部署单个 StatefulSet，其 Pod 序号映射到目标优先级档，并为每一档生成相应的 GCPBackendPolicy 资源。
:::


```bash
export PROVIDER_NAME=gke
helm install ${GUIDE_NAME} \
  ${ROUTER_GATEWAY_CHART} \
  -f ${ROUTER_BASE_VALUES} \
  ${MONITORING_VALUES} \
  -f ${ROUTER_VALUES} \
  --set provider.name=${PROVIDER_NAME} \
  --set provider.gke.preferredBackends.enabled=true \
  --set provider.gke.preferredBackends.preferredReplicas=1 \
  --set provider.gke.preferredBackends.defaultReplicas=1 \
  --set httpRoute.create=true \
  --set httpRoute.inferenceGatewayName=llm-d-inference-gateway \
  -n ${NAMESPACE} --version ${ROUTER_CHART_VERSION}
```

关键配置参数（参见 [`values.yaml`](https://github.com/llm-d/llm-d-router/blob/v0.11.0/config/charts/llm-d-router-gateway/values.yaml)）：
* `preferredReplicas`（默认：`1`）：固定在 `PREFERRED` 后端偏好档（`epp-0`）上的活跃主 Pod 序号的副本数。设置为大于 1 的值可以扩展并发活跃路由容量。
* `defaultReplicas`（默认：`1`）：固定在 `DEFAULT` 后端偏好档（`epp-1`）上的备用 Pod 序号的副本数。设置为大于 1 的值可以扩展热备故障切换容量。
* `balancingMode`（默认：`RATE`）：用于确定负载阈值的[计算模式](https://docs.cloud.google.com/load-balancing/docs/backend-service#traffic_distribution)（`RATE`、`UTILIZATION` 或 `CONNECTION`）。
* `maxRatePerEndpoint`（默认：`100`）：每个 Pod 实例在溢出到备用档之前的每秒最大请求数。
* `capacityScalerPercent`（默认：`100`）：有效容量上限百分比（0 到 100）。

#### 2. **使用 GKE 覆盖层部署模型服务器：** {#2-deploy-the-model-server-with-the-gke-overlay}

```bash
export ACCELERATOR_TYPE=gpu # 可选值：gpu、amd、xpu、hpu、tpu/v6、tpu/v7、cpu
export MODEL_SERVER=vllm    # 可选值：vllm、sglang、trtllm
kubectl apply -n ${NAMESPACE} -k ${REPO_ROOT}/guides/${GUIDE_NAME}/modelserver/${ACCELERATOR_TYPE}/${MODEL_SERVER}/gke/
```

#### 3. **发现各可用区中的主首选网络端点组（NEG），并将其挂接到生成的 Google Cloud `BackendService`：** {#3-discover-and-attach-the-primary-preferred-network-endpoint-groups-negs-across-zones-to-the-generated-google-cloud-backendservice}

:::note
`InferencePool` 资源原生指向备用的后备 Service（`Service/${GUIDE_NAME}-epp-backup`）。
把声明式的 Gateway 所有权锚定在备用 Service 上，可以确保 GKE Gateway 控制器的调谐循环不会在 Pod 重启或更新期间解除手动挂接的主 NEG。
:::


```bash
export PROJECT="<your GCP project>"
export REGION="<your GCP region>"
export NAMESPACE="<your namespace>"
export GUIDE_NAME="<llm-d guide name>"

export BACKEND_SERVICE=$(gcloud compute backend-services list --project=${PROJECT} --format="value(name)" | grep "${GUIDE_NAME}-epp")

export PRIMARY_NEG=$(kubectl get svc ${GUIDE_NAME}-epp -n ${NAMESPACE} -o jsonpath='{.metadata.annotations.cloud\.google\.com/neg-status}' | jq -r '.network_endpoint_groups["9002"]')

for ZONE in $(kubectl get svc ${GUIDE_NAME}-epp -n ${NAMESPACE} -o jsonpath='{.metadata.annotations.cloud\.google\.com/neg-status}' | jq -r '.zones[]'); do
  gcloud compute backend-services add-backend ${BACKEND_SERVICE} \
    --network-endpoint-group=${PRIMARY_NEG} \
    --network-endpoint-group-zone=${ZONE} \
    --region=${REGION} \
    --project=${PROJECT} \
    --balancing-mode=RATE \
    --max-rate-per-endpoint=100
  sleep 15
done
```

:::info
一旦把各可用区的 NEG 挂接到 Google Cloud `BackendService`，之后再扩缩副本数（`preferredReplicas` 或 `defaultReplicas`）或重启 Pod，都不需要再次运行 `gcloud` 命令。GKE NEG 控制器会自动把各个 Pod 的 IP 端点同步到已注册的可用区 NEG 中。

如果删除并重新创建父级 `Gateway` 或 `InferencePool` 资源，GKE Gateway 控制器会用新的云端标识符重新创建底层的 Google Cloud `BackendService`。此时，请重新执行上面的挂接流程，把主可用区 NEG 挂接到新创建的 `BackendService` 上。
:::


## 第 5 步：发送请求 {#step-5-send-a-request}

获取 `Gateway` 的外部地址：

```bash
export IP=$(kubectl get gateway llm-d-inference-gateway -n ${NAMESPACE} -o jsonpath='{.status.addresses[0].value}')
```

通过托管的 `Gateway` 发送推理请求：

```bash
curl -X POST http://${IP}/v1/completions \
    -H 'Content-Type: application/json' \
    -d '{
        "model": '\"${MODEL_NAME}\"',
        "prompt": "How are you today?"
    }' | jq
```

## 清理 {#cleanup}

```bash
kubectl delete gateway llm-d-inference-gateway -n ${NAMESPACE}
```

## 故障排查 {#troubleshooting}

### Gateway 未显示 `PROGRAMMED=True` {#gateway-not-showing-programmedtrue}

```bash
kubectl describe gateway llm-d-inference-gateway -n ${NAMESPACE}
```

确认所有前提条件都已完成，尤其是[在集群中启用 Gateway API](https://cloud.google.com/kubernetes-engine/docs/how-to/deploying-gateways#enable-gateway)和[配置仅代理子网](https://cloud.google.com/kubernetes-engine/docs/how-to/deploying-gateways#configure_a_proxy-only_subnet)。同时确保集群运行的是[受支持的 GKE 版本](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/deploy-gke-inference-gateway#gateway-controller-requirements)。

### HTTPRoute 未被接受 {#httproute-not-accepted}

```bash
kubectl describe httproute ${GUIDE_NAME} -n ${NAMESPACE}
```

确认 `parentRefs` 与 Gateway 名称一致，`backendRefs` 与 InferencePool 名称一致。

### Gateway IP 无响应 {#no-response-from-gateway-ip}

```bash
kubectl get gateway llm-d-inference-gateway  -n ${NAMESPACE} -o jsonpath='{.status.addresses[0].value}'
```

如果地址为空，说明 Gateway 可能仍在等待 LoadBalancer 服务。请检查集群是否支持外部负载均衡器。

### 收到 `fault filter abort` 响应 {#getting-fault-filter-abort-response}

可能由以下几个问题导致：

1. 请求不匹配 HTTPRoute 上设置的路由规则。
2. 网关的后端路由配置有误。配置正确时，HTTPRoute 的状态中应有一个类型为 `Reconciled`、原因为 `ReconciliationSucceeded` 的条件。
