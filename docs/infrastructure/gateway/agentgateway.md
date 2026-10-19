# Agentgateway

本指南介绍如何以 [agentgateway](https://agentgateway.dev/) 作为推理网关部署 llm-d。完成后，推理请求将从 agentgateway 管理的 `Gateway` 经由 llm-d EPP 流向你的模型服务器。

:::note
本指南假定你已熟悉 [Gateway API](https://gateway-api.sigs.k8s.io/) 和 llm-d。
:::


## 前提条件 {#prerequisites}

1. 在部署某个成熟路径指南的过程中，应已设置环境变量 `${GUIDE_NAME}`、`${MODEL_NAME}` 和 `${NAMESPACE}`。
2. 一个运行最近三个 [Kubernetes 版本](https://kubernetes.io/releases/)之一的 Kubernetes 集群
3. [Helm](https://helm.sh/docs/intro/install/)
4. [jq](https://jqlang.org/download/)

## 第 1 步：安装 Gateway API 和 Gateway API Inference Extension CRD {#step-1-install-gateway-api-and-gateway-api-inference-extension-crds}

按照 [CRD 安装指南](./install-crds.md)安装所需的 CRD。

## 第 2 步：安装 Agentgateway {#step-2-install-agentgateway}

安装 agentgateway 的 CRD 和控制面，并启用推理扩展支持：

```bash
AGENTGATEWAY_VERSION=v1.1.0

helm upgrade --install agentgateway-crds \
  oci://cr.agentgateway.dev/charts/agentgateway-crds \
  --namespace agentgateway-system \
  --create-namespace \
  --version ${AGENTGATEWAY_VERSION}

helm upgrade --install agentgateway \
  oci://cr.agentgateway.dev/charts/agentgateway \
  --namespace agentgateway-system \
  --create-namespace \
  --version ${AGENTGATEWAY_VERSION} \
  --set inferenceExtension.enabled=true
```

验证安装：

```bash
kubectl get pods -n agentgateway-system
kubectl get gatewayclass agentgateway
```

预期输出：

```text
NAME           CONTROLLER                      ACCEPTED   AGE
agentgateway   agentgateway.dev/agentgateway   True       30s
```

## 第 3 步：部署 Gateway {#step-3-deploy-the-gateway}

设置与你的部署相匹配的 llm-d 版本：

```bash
LLM_D_VERSION=main  # 使用 'main' 获取最新版本，或使用发布标签，如 'v0.7.0'
```

### Agentgateway {#agentgateway-1}

部署一个适用于 `agentgateway` 的网关，使用 `agentgateway` 网关类。这是 llm-d 中首选的自行安装推理网关方案。

```bash
kubectl apply -k "https://github.com/llm-d/llm-d/guides/recipes/gateway/agentgateway?ref=${LLM_D_VERSION}" -n ${NAMESPACE}
```

### Agentgateway（OpenShift） {#agentgateway-openshift}

部署首选的面向 OpenShift 的 `agentgateway` 方案。渲染出的 `Gateway` 使用 `agentgateway` GatewayClass，以及一个面向 OpenShift 的 `AgentgatewayParameters` 资源。

```bash
kubectl apply -k "https://github.com/llm-d/llm-d/guides/recipes/gateway/agentgateway-openshift?ref=${LLM_D_VERSION}" -n ${NAMESPACE}
```

确认 `Gateway` 已就绪（programmed）：

```bash
kubectl get gateway llm-d-inference-gateway -n ${NAMESPACE}
```

预期输出：

```text
NAME                      CLASS          ADDRESS         PROGRAMMED   AGE
llm-d-inference-gateway   agentgateway   10.xx.xx.xx     True         30s
```

等待 `PROGRAMMED` 显示为 `True` 后再继续。

## 第 4 步：发送请求 {#step-4-send-a-request}

:::info
发送请求之前，必须先部署一个成熟路径指南。它会部署模型服务器、一个 `InferencePool`，以及把 Gateway 连接到该资源池的 `HTTPRoute`。
:::


获取 `Gateway` 的外部地址：

```bash
export IP=$(kubectl get gateway llm-d-inference-gateway -n ${NAMESPACE} -o jsonpath='{.status.addresses[0].value}')
```

通过托管的 `Gateway` 发送推理请求：

```bash
curl -X POST http://${IP}/v1/completions \
    -H 'Content-Type: application/json' \
    -H 'X-Gateway-Base-Model-Name: '"$GUIDE_NAME"'' \
    -d '{
        "model": '\"${MODEL_NAME}\"',
        "prompt": "How are you today?"
    }' | jq
```

## 清理 {#cleanup}

```bash
kubectl delete gateway llm-d-inference-gateway -n ${NAMESPACE}
helm uninstall agentgateway -n agentgateway-system
helm uninstall agentgateway-crds -n agentgateway-system
kubectl delete namespace agentgateway-system
kubectl delete gatewayclass agentgateway
```

要卸载 Gateway API 和 Gateway API Inference Extension 的 CRD，请参阅 [CRD 安装指南](./install-crds.md#uninstalling-gateway-api-crds)。

## 故障排查 {#troubleshooting}

### Gateway 未显示 `PROGRAMMED=True` {#gateway-not-showing-programmedtrue}

```bash
kubectl describe gateway llm-d-inference-gateway -n ${NAMESPACE}
kubectl get pods -n agentgateway-system
kubectl logs -n agentgateway-system deployment/agentgateway --tail=20
```

确认 `agentgateway` `GatewayClass` 存在且已被接受：

```bash
kubectl get gatewayclass agentgateway
```

### HTTPRoute 未被接受 {#httproute-not-accepted}

```bash
kubectl describe httproute ${GUIDE_NAME} -n ${NAMESPACE}
```

确认 `parentRefs` 与 Gateway 名称一致，`backendRefs` 与 InferencePool 名称一致。

### Gateway IP 无响应 {#no-response-from-gateway-ip}

```bash
kubectl get gateway llm-d-inference-gateway -n ${NAMESPACE} -o jsonpath='{.status.addresses[0].value}'
```

如果地址为空，说明 Gateway 可能仍在等待 LoadBalancer 服务。请检查集群是否支持外部负载均衡器。
