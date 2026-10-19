# Envoy AI Gateway

本指南介绍如何以 [Envoy AI Gateway](https://aigateway.envoyproxy.io/) 作为推理网关部署 llm-d。完成后，推理请求将从 Envoy 管理的 `Gateway` 经由 llm-d EPP 流向你的模型服务器。

:::note
本指南假定你已熟悉 [Gateway API](https://gateway-api.sigs.k8s.io/) 和 llm-d。
:::


## 前提条件 {#prerequisites}

1. 在部署某个成熟路径指南的过程中，应已设置环境变量 `${GUIDE_NAME}`、`${MODEL_NAME}` 和 `${NAMESPACE}`。
2. 一个运行最近三个 [Kubernetes 版本](https://kubernetes.io/releases/)之一的 Kubernetes 集群（最低 Kubernetes 1.32）
3. [Helm](https://helm.sh/docs/intro/install/)
4. [jq](https://jqlang.org/download/)

## 第 1 步：安装 Gateway API 和 Gateway API Inference Extension CRD {#step-1-install-gateway-api-and-gateway-api-inference-extension-crds}

按照 [CRD 安装指南](./install-crds.md)安装所需的 CRD。

## 第 2 步：安装 Envoy AI Gateway {#step-2-install-envoy-ai-gateway}

使用 AI Gateway 集成配置值、token 限流插件和 InferencePool 插件安装 Envoy Gateway：

```bash
ENVOY_GATEWAY_VERSION=v1.8.1

# 先安装 CRD，跳过上一步已安装的 Gateway API CRD。
#
# 注 1：由于 Helm 在处理 templates/ 目录中的大型 CRD 时存在已知限制，
# 这里使用 helm template 通过管道传给 kubectl apply，而不是 helm install：https://github.com/helm/helm/pull/12277
# 注 2：在该问题修复之前，我们会过滤 Helm template 的输出以去掉有问题的行：https://github.com/helm/helm/pull/32217
helm template eg-crds oci://docker.io/envoyproxy/gateway-crds-helm \
  --version ${ENVOY_GATEWAY_VERSION} \
  --set crds.gatewayAPI.enabled=false \
  --set crds.envoyGateway.enabled=true \
  | grep -v '^Pulled:' | grep -v '^Digest:' | kubectl apply --server-side -f -

# 安装 Envoy Gateway
helm upgrade -i eg oci://docker.io/envoyproxy/gateway-helm \
  --version ${ENVOY_GATEWAY_VERSION} \
  --namespace envoy-gateway-system \
  --create-namespace \
  --skip-crds \
  -f https://raw.githubusercontent.com/envoyproxy/ai-gateway/main/manifests/envoy-gateway-values.yaml \
  -f https://raw.githubusercontent.com/envoyproxy/ai-gateway/main/examples/inference-pool/envoy-gateway-values-addon.yaml

# 授予 Envoy Gateway 监视 InferencePool 资源的权限
kubectl apply -f - <<EOF
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: envoy-gateway-inference-access
rules:
- apiGroups:
  - inference.networking.k8s.io
  resources:
  - inferencepools
  verbs:
  - get
  - list
  - watch
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: envoy-gateway-inference-access
subjects:
- kind: ServiceAccount
  name: envoy-gateway
  namespace: envoy-gateway-system
roleRef:
  kind: ClusterRole
  name: envoy-gateway-inference-access
  apiGroup: rbac.authorization.k8s.io
EOF

kubectl wait --timeout=2m -n envoy-gateway-system deployment/envoy-gateway --for=condition=Available
```

安装 Envoy AI Gateway 的 CRD 和控制器：

```bash
ENVOY_AI_GATEWAY_VERSION=v0.7.0

helm upgrade -i envoy-ai-gateway-crd oci://docker.io/envoyproxy/ai-gateway-crds-helm \
  --version ${ENVOY_AI_GATEWAY_VERSION} \
  --namespace envoy-ai-gateway-system \
  --create-namespace

helm upgrade -i envoy-ai-gateway oci://docker.io/envoyproxy/ai-gateway-helm \
  --version ${ENVOY_AI_GATEWAY_VERSION} \
  --namespace envoy-ai-gateway-system \
  --create-namespace

kubectl wait --timeout=2m -n envoy-ai-gateway-system deployment/ai-gateway-controller --for=condition=Available
```

创建 GatewayClass：

```bash
kubectl apply -f - <<EOF
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: envoy-ai-gateway
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
EOF
```

验证安装：

```bash
kubectl get pods -n envoy-gateway-system
kubectl get pods -n envoy-ai-gateway-system
kubectl get gatewayclass envoy-ai-gateway
```

预期输出：

```text
NAME   CONTROLLER                                      ACCEPTED   AGE
envoy-ai-gateway   gateway.envoyproxy.io/gatewayclass-controller   True       30s
```

## 第 3 步：部署 Gateway {#step-3-deploy-the-gateway}

设置与你的部署相匹配的 llm-d 版本：

```bash
LLM_D_VERSION=main  # 使用 'main' 获取最新版本，或使用发布标签，如 'v0.7.0'
```

部署一个适用于 `envoy-ai-gateway` 的网关，使用 `envoy-ai-gateway` 网关类。这是 llm-d 中首选的自行安装推理网关方案。

```bash
kubectl apply -k "https://github.com/llm-d/llm-d/guides/recipes/gateway/envoy-ai-gateway?ref=${LLM_D_VERSION}" -n ${NAMESPACE}
```

确认 `Gateway` 已就绪（programmed）：

```bash
kubectl get gateway llm-d-inference-gateway -n ${NAMESPACE}
```

预期输出：

```text
NAME                      CLASS   ADDRESS         PROGRAMMED   AGE
llm-d-inference-gateway   envoy-ai-gateway    10.xx.xx.xx     True         30s
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
kubectl delete clienttrafficpolicy client-buffer-limit -n ${NAMESPACE}
kubectl delete gateway llm-d-inference-gateway -n ${NAMESPACE}
helm uninstall envoy-ai-gateway -n envoy-ai-gateway-system
helm uninstall envoy-ai-gateway-crd -n envoy-ai-gateway-system
kubectl delete namespace envoy-ai-gateway-system
helm uninstall eg -n envoy-gateway-system
kubectl delete namespace envoy-gateway-system
helm template eg-crds oci://docker.io/envoyproxy/gateway-crds-helm \
  --version ${ENVOY_GATEWAY_VERSION} \
  --set crds.gatewayAPI.enabled=false \
  --set crds.envoyGateway.enabled=true \
  | grep -v '^Pulled:' | grep -v '^Digest:' | kubectl delete -f -
kubectl delete gatewayclass envoy-ai-gateway
```

要卸载 Gateway API 和 Gateway API Inference Extension 的 CRD，请参阅 [CRD 安装指南](./install-crds.md#uninstalling-gateway-api-crds)。

## 故障排查 {#troubleshooting}

### Gateway 未显示 `PROGRAMMED=True` {#gateway-not-showing-programmedtrue}

```bash
kubectl describe gateway llm-d-inference-gateway -n ${NAMESPACE}
kubectl get pods -n envoy-gateway-system
kubectl logs -n envoy-gateway-system deployment/envoy-gateway --tail=20
```

确认 `envoy-ai-gateway` `GatewayClass` 存在且已被接受：

```bash
kubectl get gatewayclass envoy-ai-gateway
```

同时检查 Envoy AI Gateway 控制器是否在运行：

```bash
kubectl get pods -n envoy-ai-gateway-system
kubectl logs -n envoy-ai-gateway-system deployment/ai-gateway-controller --tail=20
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
