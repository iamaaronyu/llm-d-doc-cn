# Istio

本指南介绍如何以 [Istio](https://istio.io/) 作为推理网关部署 llm-d。完成后，推理请求将从 Istio 管理的 `Gateway` 经由 llm-d EPP 流向你的模型服务器。

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

## 第 2 步：安装 Istio {#step-2-install-istio}

安装 Istio 并启用推理扩展支持：

```bash
ISTIO_VERSION=1.29.2
curl -L https://istio.io/downloadIstio | ISTIO_VERSION=${ISTIO_VERSION} sh -
export PATH="$PWD/istio-${ISTIO_VERSION}/bin:$PATH"
istioctl install -y \
  --set values.pilot.env.ENABLE_GATEWAY_API_INFERENCE_EXTENSION=true
```

验证安装：

```bash
kubectl get pods -n istio-system
```

预期输出：

```text
NAME                      READY   STATUS    RESTARTS   AGE
istiod-xxxxxxxxxx-xxxxx   1/1     Running   0          30s
```

## 第 3 步：部署 Gateway {#step-3-deploy-the-gateway}

设置与你的部署相匹配的 llm-d 版本：

```bash
LLM_D_VERSION=main  # 使用 'main' 获取最新版本，或使用发布标签，如 'v0.7.0'
```

创建一个 `Gateway` 资源。Istio 会监视该资源，并创建一个基于 Envoy 的代理来接收传入流量。

```bash
kubectl apply -k "https://github.com/llm-d/llm-d/guides/recipes/gateway/istio?ref=${LLM_D_VERSION}" -n ${NAMESPACE}
```

确认 Gateway 已就绪（programmed）：

```bash
kubectl get gateway llm-d-inference-gateway -n ${NAMESPACE}
```

预期输出：

```text
NAME                      CLASS   ADDRESS         PROGRAMMED   AGE
llm-d-inference-gateway   istio   10.xx.xx.xx     True         30s
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
    -d '{
        "model": '\"${MODEL_NAME}\"',
        "prompt": "How are you today?"
    }' | jq
```

## 清理 {#cleanup}

```bash
kubectl delete gateway llm-d-inference-gateway -n ${NAMESPACE}
istioctl uninstall --purge -y
kubectl delete namespace istio-system
kubectl delete gatewayclass istio istio-remote
```

要卸载 Gateway API 和 Gateway API Inference Extension 的 CRD，请参阅 [CRD 安装指南](./install-crds.md#uninstalling-gateway-api-crds)。

## 故障排查 {#troubleshooting}

### Gateway 未显示 `PROGRAMMED=True` {#gateway-not-showing-programmedtrue}

```bash
kubectl describe gateway llm-d-inference-gateway -n ${NAMESPACE}
kubectl get pods -n istio-system
kubectl logs -n istio-system deployment/istiod --tail=20
```

确认安装 Istio 时启用了推理扩展参数。

### HTTPRoute 未被接受 {#httproute-not-accepted}

```bash
kubectl describe httproute ${GUIDE_NAME} -n ${NAMESPACE}
```

确认 `parentRefs` 与 Gateway 名称一致，`backendRefs` 与 InferencePool 名称一致。

### Gateway IP 无响应 {#no-response-from-gateway-ip}

```bash
kubectl get gateway llm-d-inference-gateway -o jsonpath='{.status.addresses[0].value}' -n ${NAMESPACE}
```

如果地址为空，说明 Gateway 可能仍在等待 LoadBalancer 服务。请检查集群是否支持外部负载均衡器。
