# 使用 Kong AI Gateway 路由 llm-d 推理技术栈与外部 API

本指南演示如何在 Kubernetes 上部署 **Kong AI Gateway**（Helm Chart、无数据库模式、Kong Ingress Controller），在现有的 **llm-d 推理技术栈**与外部 LLM 服务商 API 之间路由流量。

---

## 概览 {#overview}

单个 Kong AI Gateway 部署可以同时承接：

1. **集群内的模型端点**：在你的 Kubernetes 集群中提供模型服务的现有 llm-d 推理技术栈（通过 `ai-proxy` 插件，把一个 `openai` 提供方指向 llm-d 端点）。
2. **外部服务商 API**：第三方 LLM 服务（通过 `ai-proxy` 插件，把一个 `gemini` 提供方指向 Google AI Studio）。

所有 Kong 组件（网关、路由、插件、Secret）都位于专用的 `kong` 命名空间中，使 llm-d 推理技术栈在其自己的命名空间中保持隔离。

终端用户可以：

- 使用在 Kong 中集中管理的 API 密钥调用外部服务商 API（服务商密钥存放在 Kubernetes Secret 中，从不暴露给客户端应用）。
- 通过统一的、兼容 OpenAI 的路由调用由 llm-d 推理技术栈提供的自托管模型。

---

## 前提条件 {#prerequisites}

1. **Kubernetes 集群**：一个运行中的 Kubernetes 集群，已配置 `kubectl` 并安装了 [Gateway API CRD](https://gateway-api.sigs.k8s.io/)。
2. **llm-d 推理技术栈**：一套使用[优化基线](../../well-lit-paths/foundations/optimized-baseline.md)搭建、正在提供模型服务（例如 `Qwen/Qwen3-32B`）的 llm-d 部署。
   - **网关模式（默认）**：通过 Kubernetes Gateway IP 访问（`http://<gateway-ip>/v1`）。
   - **独立模式（可选）**：直接通过端点选择器（EPP）Service 访问：
     `http://optimized-baseline-epp.llm-d-optimized-baseline.svc.cluster.local:80/v1`。
3. **外部服务商 API 密钥**：用于 `gemini-3.5-flash` 的 Google AI Studio API 密钥。
4. **本地工具**：`kubectl`、`helm` 和 `curl`。

:::note
**已验证的版本**：本指南已使用 Kong Gateway `v3.9.3`、Kong Ingress Controller `v3.5.0`（`kong/ingress` Helm Chart `v0.24.0`）和 Gateway API `v1.2.1` 进行测试和验证。
:::


创建 Kong 的目标命名空间：

```bash
export NAMESPACE=kong

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
```

---

## 第 1 步：为外部服务商密钥创建 Secret {#step-1-create-secret-for-external-provider-keys}

Kong 通过插件自定义资源（CRD）中的 `configPatches` 引用，从 Kubernetes Secret 中安全地获取外部服务商密钥，确保密钥从不以明文形式出现在插件 spec 中。

```bash
export GEMINI_API_KEY="<your-gemini-api-key>"

kubectl -n "$NAMESPACE" create secret generic ai-provider-keys \
  --from-literal=gemini-api-key="\"$GEMINI_API_KEY\""   # 注意内嵌的双引号
```

:::info
把 `<your-gemini-api-key>` 替换为你实际的 Google AI Studio API 密钥。Kong Ingress Controller 会把 `configPatches` 的值直接作为 JSON 替换进去；字符串值需要内嵌双引号（例如 `"\"$GEMINI_API_KEY\""`），而数字或布尔类型的补丁值则不需要。
:::


---

## 第 2 步：通过 Helm 安装 Kong Ingress Controller + Gateway {#step-2-install-kong-ingress-controller--gateway-via-helm}

确保集群上已安装 Gateway API，并确认标准 CRD 可用：

```bash
kubectl get crd gateways.gateway.networking.k8s.io httproutes.gateway.networking.k8s.io
```

添加官方 Kong Helm 仓库并安装 `kong/ingress` Chart（部署 Kong Ingress Controller + 无数据库模式的 Kong Gateway 数据面）：

```bash
helm repo add kong https://charts.konghq.com
helm repo update

helm install kong kong/ingress -n "$NAMESPACE"
kubectl -n "$NAMESPACE" wait --for=condition=Available deploy/kong-controller deploy/kong-gateway --timeout=300s
```

查看已部署的服务：

```bash
kubectl get deploy,svc -n "$NAMESPACE"
```

预期输出：

```text
NAME                              READY   UP-TO-DATE   AVAILABLE
deployment.apps/kong-controller   1/1     1            1
deployment.apps/kong-gateway      1/1     1            1

NAME                                         TYPE           CLUSTER-IP     EXTERNAL-IP   PORT(S)
service/kong-controller-metrics              ClusterIP      <cluster-ip>   <none>        10255/TCP,10254/TCP
service/kong-controller-validation-webhook   ClusterIP      <cluster-ip>   <none>        443/TCP
service/kong-gateway-admin                   ClusterIP      None           <none>        8444/TCP
service/kong-gateway-manager                 NodePort       <cluster-ip>   <none>        8002:31071/TCP,8445:31084/TCP
service/kong-gateway-proxy                   LoadBalancer   <cluster-ip>   <proxy-ip>    80:32117/TCP,443:30425/TCP
```

导出代理 LoadBalancer 的 IP 或主机名，供验证命令使用：

```bash
export PROXY_IP=$(kubectl -n "$NAMESPACE" get svc kong-gateway-proxy \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}{.status.loadBalancer.ingress[0].hostname}')
```

---

## 第 3 步：创建 GatewayClass、Gateway 和占位 Service {#step-3-create-gatewayclass-gateway-and-placeholder-service}

为 Kong 创建 `GatewayClass` 和 `Gateway` 资源，同时创建一个占位 Service（`ai-placeholder`），第 4 步中的 `HTTPRoute` 资源会引用它，以满足 Gateway API 的结构要求。

创建 `kong-gateway.yaml`：

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: kong
  annotations:
    konghq.com/gatewayclass-unmanaged: "true"
spec:
  controllerName: konghq.com/kic-gateway-controller
---
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: kong
spec:
  gatewayClassName: kong
  listeners:
    - name: proxy
      port: 80
      protocol: HTTP
      allowedRoutes:
        namespaces:
          from: Same
---
apiVersion: v1
kind: Service
metadata:
  name: ai-placeholder
spec:
  type: ClusterIP
  ports:
    - port: 80
      targetPort: 80
```

应用这些资源：

```bash
kubectl apply -n "$NAMESPACE" -f kong-gateway.yaml
```

---

## 第 4 步：配置路由和 `ai-proxy` 插件 {#step-4-configure-routes-and-ai-proxy-plugins}

:::warning
**必须显式指定端口**：请始终在 `upstream_url` 中包含显式端口（例如 `http://<gateway-ip>:80/...`）。在 Kong Gateway 3.8 之前的版本中，`openai` 驱动即使对于 `http://` URL 也默认使用 443 端口，省略端口会导致连接超时并返回 `503 The upstream server is currently unavailable`。指定 `:80` 不会有任何副作用，并能确保在所有 Kong Gateway 版本中都兼容。
:::


获取 llm-d Gateway 的 IP，用于替换 `<gateway-ip>`：

```bash
kubectl -n llm-d-optimized-baseline get gateway llm-d-inference-gateway \
  -o jsonpath='{.status.addresses[0].value}'
```

创建 `models.yaml`：

```yaml
# ─────────────────────────────────────────────────────────────────────
# 1) 默认：llm-d 网关模式
# 路由到 llm-d 的 Gateway API 端点（InferenceGateway）。
# 指向你的 Kubernetes Gateway IP（来自 kubectl get gateway）。
# ─────────────────────────────────────────────────────────────────────
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: ai-proxy-qwen3-32b
plugin: ai-proxy
config:
  route_type: llm/v1/chat
  model:
    provider: openai
    name: Qwen/Qwen3-32B      # 必须与后端模型 ID 一致
    options:
      upstream_url: http://<gateway-ip>:80/v1/chat/completions
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: qwen3-32b
  annotations:
    konghq.com/plugins: ai-proxy-qwen3-32b, key-auth, rate-limiting
spec:
  parentRefs:
    - name: kong
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /qwen3-32b
      backendRefs:
        - name: ai-placeholder
          port: 80
---
# ─────────────────────────────────────────────────────────────────────
# 2) 可选：llm-d 独立模式
# 直接路由到 EPP Service 端点（绕过 Gateway API）。
# ─────────────────────────────────────────────────────────────────────
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: ai-proxy-qwen3-32b-standalone
plugin: ai-proxy
config:
  route_type: llm/v1/chat
  model:
    provider: openai
    name: Qwen/Qwen3-32B
    options:
      upstream_url: http://optimized-baseline-epp.llm-d-optimized-baseline.svc.cluster.local:80/v1/chat/completions
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: qwen3-32b-standalone
  annotations:
    konghq.com/plugins: ai-proxy-qwen3-32b-standalone, key-auth, rate-limiting
spec:
  parentRefs:
    - name: kong
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /qwen3-32b-standalone
      backendRefs:
        - name: ai-placeholder
          port: 80
---
# ─────────────────────────────────────────────────────────────────────
# 3) 外部 API：Google Gemini
# 使用通过 configPatches 从 Secret 注入的 Google AI Studio 密钥进行认证。
# ─────────────────────────────────────────────────────────────────────
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: ai-proxy-gemini-flash
plugin: ai-proxy
config:
  route_type: llm/v1/chat
  auth:
    param_name: key
    param_location: query
  model:
    provider: gemini
    name: gemini-3.5-flash
configPatches:
  - path: /auth/param_value
    valueFrom:
      secretKeyRef:
        name: ai-provider-keys
        key: gemini-api-key
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: gemini-flash
  annotations:
    konghq.com/plugins: ai-proxy-gemini-flash, key-auth, rate-limiting
spec:
  parentRefs:
    - name: kong
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /gemini-flash
      backendRefs:
        - name: ai-placeholder
          port: 80
---
# ─────────────────────────────────────────────────────────────────────
# 4) 安全与治理：key-auth 和 rate-limiting
# 在所有路由上强制执行客户端认证和请求限流。
# ─────────────────────────────────────────────────────────────────────
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: key-auth
plugin: key-auth
config:
  key_names:
    - apikey
  hide_credentials: true
---
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: rate-limiting
plugin: rate-limiting
config:
  minute: 60
  policy: local
```

应用路由定义和安全插件：

```bash
kubectl apply -n "$NAMESPACE" -f models.yaml
```

:::note
- **失败关闭的占位后端**：Gateway API 的 `HTTPRoute` 需要一个有效的 `backendRef`。由于 `ai-proxy` 会用目标模型的 `upstream_url` 替换上游请求路径，通常不会访问到 `ai-placeholder` Service。使用一个没有选择器的 `ClusterIP` Service 可以确保：如果某个 `ai-proxy` 插件未能成功下发或缺失，Kong 会以 `503 Service Unavailable` 立即失败关闭，而不是代理到 localhost。
- **认证请求头**：Kong 的 `key-auth` 插件比较的是完整的请求头取值，并不会去掉 `Bearer` 前缀，因此客户端通过 `apikey` 请求头传递密钥（`-H "apikey: $CLIENT_KEY"`）。OpenAI SDK 客户端可以通过 `default_headers={"apikey": CLIENT_KEY}` 发送它。如果客户端只能发送 `Authorization: Bearer <key>`，请添加一个 Kong `pre-function` 插件，在 `key-auth` 运行之前把 token 复制到 `apikey` 中并清除原始请求头。
- **本地限流（`policy: local`）**：计数器存放在 Pod 内存中，没有任何外部依赖，这意味着每分钟 60 次请求的限制在每个 Kong 数据面副本上独立生效（例如 N 个副本合计每分钟 60 × N 次请求）。如需在多个副本之间实现严格的集群范围限流，请配置 `policy: redis` 并使用共享的 Redis 实例。
- **模型固定**：`ai-proxy` 为每条路由固定模型。客户端可以在请求体中省略 `"model"`；如果提供了，必须与 `model.name` 一致，否则 Kong 会返回 HTTP `400 Bad Request`。
:::


接下来，创建一个授权的客户端消费者及其 API 密钥凭据：

```bash
# 1) 生成客户端 API 密钥，并存入一个带标签的凭据 Secret
CLIENT_KEY="key-$(openssl rand -hex 16)"

kubectl apply -n "$NAMESPACE" -f - <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: client-app-key
  labels:
    konghq.com/credential: key-auth
stringData:
  key: "$CLIENT_KEY"
---
# 2) 创建引用该凭据 Secret 的 KongConsumer
apiVersion: configuration.konghq.com/v1
kind: KongConsumer
metadata:
  name: client-app
  annotations:
    kubernetes.io/ingress.class: kong
username: client-app
credentials:
  - client-app-key
EOF
```

---

## 第 5 步：验证 {#step-5-verification}

### 1. 验证 Gateway API 资源已下发 {#1-verify-gateway-api-resource-programming}

检查所有 Gateway API 资源、Kong 插件和消费者是否都已下发（programmed）：

```bash
kubectl -n "$NAMESPACE" get gateway,httproute,kongplugin,kongconsumer
```

预期输出：

```text
NAME                                     CLASS   ADDRESS      PROGRAMMED   AGE
gateway.gateway.networking.k8s.io/kong   kong    <proxy-ip>   True         77m

NAME                                                        HOSTNAMES   AGE
httproute.gateway.networking.k8s.io/gemini-flash                        77m
httproute.gateway.networking.k8s.io/qwen3-32b                           77m
httproute.gateway.networking.k8s.io/qwen3-32b-standalone                77m

NAME                                                               PLUGIN-TYPE     AGE   PROGRAMMED
kongplugin.configuration.konghq.com/ai-proxy-gemini-flash         ai-proxy        69m   True
kongplugin.configuration.konghq.com/ai-proxy-qwen3-32b            ai-proxy        71m   True
kongplugin.configuration.konghq.com/ai-proxy-qwen3-32b-standalone ai-proxy        71m   True
kongplugin.configuration.konghq.com/key-auth                      key-auth        71m   True
kongplugin.configuration.konghq.com/rate-limiting                 rate-limiting   71m   True

NAME                                               USERNAME     AGE   PROGRAMMED
kongconsumer.configuration.konghq.com/client-app   client-app   5m    True
```

### 2. 验证认证已生效（安全检查） {#2-verify-authentication-enforcement-security-check}

尝试发送一个未认证的请求，确认 Kong 会拦截未授权的访问：

```bash
curl -i -s http://$PROXY_IP/gemini-flash \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "hi"}]}'
```

预期响应（HTTP 401 Unauthorized）：

```text
HTTP/1.1 401 Unauthorized
Content-Type: application/json; charset=utf-8
Connection: keep-alive

{
  "message": "No API key found in request"
}
```

### 3. 使用客户端认证调用已配置的模型 {#3-call-configured-models-with-client-authentication}

#### A. 调用自托管模型（经网关模式的 `/qwen3-32b`） {#a-call-self-hosted-model-qwen3-32b-via-gateway-mode}

通过 `apikey` 请求头传递客户端 API 密钥：

```bash
curl -s -m 45 http://$PROXY_IP/qwen3-32b \
  -H "Content-Type: application/json" \
  -H "apikey: $CLIENT_KEY" \
  -d '{
    "messages": [{"role": "user", "content": "hi"}],
    "max_tokens": 16
  }' | jq .
```

预期响应（显示来自 llm-d 的 vLLM 系统指纹）：

```json
{
  "id": "<response-id>",
  "object": "chat.completion",
  "model": "Qwen/Qwen3-32B",
  "system_fingerprint": "vllm-0.23.0-tp2-a536750c",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "<think>\nOkay, the user said \"hi\". That's a greeting. I"
      },
      "finish_reason": "length"
    }
  ],
  "usage": {
    "prompt_tokens": 9,
    "completion_tokens": 16,
    "total_tokens": 25
  }
}
```

#### B. 调用自托管模型（经独立模式的 `/qwen3-32b-standalone`） {#b-call-self-hosted-model-qwen3-32b-standalone-via-standalone-mode}

```bash
curl -s -m 45 http://$PROXY_IP/qwen3-32b-standalone \
  -H "Content-Type: application/json" \
  -H "apikey: $CLIENT_KEY" \
  -d '{
    "messages": [{"role": "user", "content": "hi"}],
    "max_tokens": 16
  }' | jq .
```

#### C. 调用外部模型（经 Google AI Studio API 的 `/gemini-flash`） {#c-call-external-model-gemini-flash-via-google-ai-studio-api}

Kong 校验客户端的 `apikey`，把 OpenAI 请求格式转换为 Gemini API 格式，并注入上游的 Gemini API 密钥：

```bash
curl -s -m 45 http://$PROXY_IP/gemini-flash \
  -H "Content-Type: application/json" \
  -H "apikey: $CLIENT_KEY" \
  -d '{
    "messages": [{"role": "user", "content": "Reply with just: GEMINI-OK"}],
    "max_tokens": 16
  }' | jq .
```

预期响应：

```json
{
  "id": "<response-id>",
  "object": "chat.completion",
  "model": "gemini-3.5-flash",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "GEMINI-OK"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 9,
    "completion_tokens": 4,
    "total_tokens": 13
  }
}
```

---

## 清理 {#cleanup}

移除 Kong AI Gateway 部署及所有相关资源：

```bash
kubectl delete -n "$NAMESPACE" -f models.yaml
kubectl delete -n "$NAMESPACE" -f kong-gateway.yaml
kubectl delete -n "$NAMESPACE" secret client-app-key --ignore-not-found
helm uninstall kong -n "$NAMESPACE"
kubectl delete namespace "$NAMESPACE"
```
