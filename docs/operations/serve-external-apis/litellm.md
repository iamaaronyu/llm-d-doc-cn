# 使用 LiteLLM 统一承载 llm-d 推理技术栈与外部 API

本指南演示如何在 Kubernetes 上部署一个 **LiteLLM 代理**（Helm Chart，以 PostgreSQL 为后端），提供一个单一的、兼容 OpenAI 的入口，同时承接现有的 **llm-d 推理技术栈**和外部 LLM 服务商的 API。

---

## 概览 {#overview}

在基础设施前部署 LiteLLM 后，一个代理入口即可同时服务：

1. **集群内的模型端点**：在你的 Kubernetes 集群中提供模型服务的现有 llm-d 推理技术栈（例如 Qwen/Qwen3-32B）。
2. **外部服务商 API**：第三方 LLM 服务（例如通过 Google AI Studio API 密钥访问的 Google Gemini）。

终端用户可以使用 LiteLLM 生成的虚拟密钥发起兼容 OpenAI 的 API 调用，访问自托管模型或外部服务商 API，而无需直接管理各个服务商的 API 凭据。

---

## 前提条件 {#prerequisites}

1. **Kubernetes 集群**：一个运行中的 Kubernetes 集群，并已配置 `kubectl`。
2. **llm-d 推理技术栈**：一套使用[优化基线](../../well-lit-paths/foundations/optimized-baseline.md)搭建、正在提供模型服务（例如 `Qwen/Qwen3-32B`）的 llm-d 部署。
   - **网关模式（默认）**：通过 Kubernetes Gateway IP 访问（`http://<gateway-ip>/v1`）。
   - **独立模式（可选）**：直接通过端点选择器（EPP）Service 访问：
     `http://optimized-baseline-epp.llm-d-optimized-baseline.svc.cluster.local:80/v1`。
3. **外部服务商 API 密钥**：用于 `gemini/gemini-3.5-flash` 的 Google AI Studio API 密钥。
4. **本地工具**：`kubectl`、`helm`、`openssl` 和 `curl`。

:::note
**已验证的版本**：本指南已使用 LiteLLM Helm Chart `1.94.1`（`oci://ghcr.io/berriai/litellm-helm`）、LiteLLM 代理 `v1.90.2`（`ghcr.io/berriai/litellm-database`）、PostgreSQL `16` 和 Redis `7.4-alpine` 进行测试和验证。
:::


创建 LiteLLM 的目标命名空间：

```bash
export NAMESPACE=litellm

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
```

---

## 第 1 步：为 LiteLLM 创建 Secret {#step-1-create-secrets-for-litellm}

为管理操作和数据库加密生成随机密钥，并创建 LiteLLM 所需的 Kubernetes Secret：

```bash
export DB_PASSWORD="$(openssl rand -hex 24)"
export GEMINI_API_KEY="<your-gemini-api-key>"

# 1) 核心 Secret：管理员主密钥、salt 密钥（用于加密存储的凭据）以及数据库凭据
kubectl -n "$NAMESPACE" create secret generic litellm-secrets \
  --from-literal=master-key="sk-$(openssl rand -hex 24)" \
  --from-literal=salt-key="sk-$(openssl rand -hex 24)" \
  --from-literal=db-username="litellm" \
  --from-literal=db-password="$DB_PASSWORD"

# 2) 环境变量 Secret：服务商 API 密钥（以及供 Chart 环境变量使用的 salt 密钥）
SALT=$(kubectl -n "$NAMESPACE" get secret litellm-secrets -o jsonpath='{.data.salt-key}' | base64 -d)
kubectl -n "$NAMESPACE" create secret generic litellm-env \
  --from-literal=LITELLM_SALT_KEY="$SALT" \
  --from-literal=GEMINI_API_KEY="$GEMINI_API_KEY"
```

:::info
把 `<your-gemini-api-key>` 替换为你实际的 Google AI Studio API 密钥。
:::


---

## 第 2 步：搭建 PostgreSQL 和 Redis 后端 {#step-2-set-up-postgresql-and-redis-backends}

LiteLLM 需要两层存储：

1. **PostgreSQL（持久状态）**：存储虚拟密钥、用户花费指标、模型别名和审计日志。以带持久卷的 `StatefulSet` 部署。
2. **Redis（临时协调）**：在多个代理副本之间协调跨 Pod 的限流（RPM/TPM）、预算锁和花费计数器。使用官方上游镜像（`redis:7.4-alpine`）以轻量级 `Deployment` 部署。

把这两个组件都作为独立的 Kubernetes 资源部署，可以避免使用已弃用、未固定版本的第三方子 Chart，并完全掌控版本和资源。

### 1. 部署 PostgreSQL StatefulSet {#1-deploy-postgresql-statefulset}

创建 `postgres.yaml`：

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
spec:
  serviceName: postgres
  replicas: 1
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      containers:
        - name: postgres
          image: postgres:16
          env:
            - name: POSTGRES_DB
              value: litellm
            - name: POSTGRES_USER
              valueFrom:
                secretKeyRef:
                  name: litellm-secrets
                  key: db-username
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: litellm-secrets
                  key: db-password
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata
          ports:
            - containerPort: 5432
          readinessProbe:
            exec:
              command: ["sh", "-c", "pg_isready -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\""]
            initialDelaySeconds: 10
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 10Gi
---
apiVersion: v1
kind: Service
metadata:
  name: postgres
spec:
  clusterIP: None
  selector:
    app: postgres
  ports:
    - port: 5432
      targetPort: 5432
```

### 2. 部署 Redis 协调存储 {#2-deploy-redis-coordination-store}

创建 `redis.yaml`：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis
spec:
  replicas: 1
  selector:
    matchLabels:
      app: redis
  template:
    metadata:
      labels:
        app: redis
    spec:
      containers:
        - name: redis
          image: redis:7.4-alpine
          ports:
            - containerPort: 6379
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
          readinessProbe:
            exec:
              command: ["redis-cli", "ping"]
            initialDelaySeconds: 5
            periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: redis
spec:
  selector:
    app: redis
  ports:
    - port: 6379
      targetPort: 6379
```

应用这两份清单并等待就绪：

```bash
kubectl apply -n "$NAMESPACE" -f postgres.yaml -f redis.yaml

kubectl -n "$NAMESPACE" rollout status statefulset/postgres
kubectl -n "$NAMESPACE" rollout status deployment/redis
```

LiteLLM 代理在同一命名空间内通过 `postgres:5432` 访问 PostgreSQL，通过 `redis:6379` 访问 Redis。

---

## 第 3 步：编写 LiteLLM Helm 配置值并安装 {#step-3-construct-litellm-helm-values-and-install}

为 LiteLLM Helm Chart 创建一个 `values.yaml` 配置文件。`model_list` 数组为自托管的 llm-d 模型和外部服务商配置路由。

### 配置（`values.yaml`） {#configuration-valuesyaml}

```yaml
replicaCount: 3

image:
  repository: ghcr.io/berriai/litellm-database   # 内置用于数据库迁移的 Prisma 客户端
  tag: "v1.90.2"

# 以独立 Deployment（第 2 步）运行 Redis，而不是使用 Chart
# 可选的内置子 Chart，以便镜像和版本都由你掌控。
redis:
  enabled: false

# 管理员主密钥 Secret 引用
masterkeySecretName: litellm-secrets
masterkeySecretKey: master-key

# 通过集群内的 StatefulSet 集成数据库
db:
  useExisting: true
  deployStandalone: false
  endpoint: "postgres:5432"
  database: litellm
  secret:
    name: litellm-secrets
    usernameKey: db-username
    passwordKey: db-password

# 以环境变量的形式把服务商密钥传给 LiteLLM
environmentSecrets:
  - litellm-env

# 以 Helm hook Job 的形式执行数据库迁移
migrationJob:
  hooks:
    helm: { enabled: true }
    argocd: { enabled: false }

# 禁止代理 Pod 在运行时更新表结构（由迁移 Job 负责）
envVars:
  DISABLE_SCHEMA_UPDATE: "True"

proxy_config:
  # 全局路由协调：跨副本的限流和模型路由状态
  router_settings:
    redis_host: redis
    redis_port: 6379

  model_list:
    # ─────────────────────────────────────────────────────────────────
    # 1) 默认：llm-d 网关模式
    # 指向你的 Kubernetes Gateway IP（来自 `kubectl get gateway`）。
    # ─────────────────────────────────────────────────────────────────
    - model_name: qwen/qwen3-32B
      litellm_params:
        model: hosted_vllm/Qwen/Qwen3-32B
        api_base: http://<gateway-ip>/v1
        api_key: "none"          # llm-d 不需要 API 密钥
      # 自托管模型没有公开价格。以下是内部计费费率——
      # 即摊销后的 GPU 成本，而不是厂商价格。请替换为你自己的值：
      #   tokens_per_hour = 3600 x 持续输出 tok/s x 利用率
      #   output_cost_per_token = (GPU $/小时 x GPU 数) / tokens_per_hour
      # 如果不设置，LiteLLM 会把 llm-d 模型的花费记为 0，
      # 下面的 max_budget 只会统计 Gemini 的花费。
      model_info:
        input_cost_per_token: 0.0000008   # 每 100 万输入 token $0.80
        output_cost_per_token: 0.0000024  # 每 100 万输出 token $2.40

    # ─────────────────────────────────────────────────────────────────
    # 2) 可选：llm-d 独立模式
    # 直接指向 EPP Service 端点（绕过 Gateway API）。
    # ─────────────────────────────────────────────────────────────────
    - model_name: qwen/qwen3-32b-standalone
      litellm_params:
        model: hosted_vllm/Qwen/Qwen3-32B
        api_base: http://optimized-baseline-epp.llm-d-optimized-baseline.svc.cluster.local:80/v1
        api_key: "none"
      # 自托管模型没有公开价格。以下是内部计费费率——
      # 即摊销后的 GPU 成本，而不是厂商价格。请替换为你自己的值：
      #   tokens_per_hour = 3600 x 持续输出 tok/s x 利用率
      #   output_cost_per_token = (GPU $/小时 x GPU 数) / tokens_per_hour
      # 如果不设置，LiteLLM 会把 llm-d 模型的花费记为 0，
      # 下面的 max_budget 只会统计 Gemini 的花费。
      model_info:
        input_cost_per_token: 0.0000008   # 每 100 万输入 token $0.80
        output_cost_per_token: 0.0000024  # 每 100 万输出 token $2.40

    # ─────────────────────────────────────────────────────────────────
    # 3) 外部 API：Google Gemini
    # 使用通过 GEMINI_API_KEY 注入的 Google AI Studio API 密钥。
    # ─────────────────────────────────────────────────────────────────
    - model_name: gemini-flash
      litellm_params:
        model: gemini/gemini-3.5-flash
        api_key: os.environ/GEMINI_API_KEY
```

:::note
- **Redis 能保证什么、不能保证什么**：模型级的限流在 Redis 中检查，因此在所有副本之间都有效。虚拟密钥的限制（`/key/generate` 上的 `rpm_limit`）是在每个 Pod 的内存中计数并延迟同步的——在 3 个副本的情况下，一个限制为 60 RPM 的密钥可能会短暂达到约 180。花费和预算写入 PostgreSQL，同样存在延迟。如需严格的每密钥上限，请只运行一个副本，或者把 `rpm_limit` 除以副本数。
- **自托管模型的成本跟踪（`model_info`）**：商业模型（例如 `gemini-3.5-flash`）在 LiteLLM 的公开价格字典中有预置的定价。自托管模型（`hosted_vllm/*`）需要显式设置带有 `input_cost_per_token` 和 `output_cost_per_token` 的 `model_info`，这样 LiteLLM 才能准确跟踪用量花费并从虚拟密钥的预算中扣除。
:::


### 通过 Helm 安装 {#install-via-helm}

使用官方的 OCI Helm Chart 部署 LiteLLM：

```bash
helm install litellm oci://ghcr.io/berriai/litellm-helm \
  -n "$NAMESPACE" -f values.yaml

kubectl -n "$NAMESPACE" rollout status deploy/litellm
```

---

## 第 4 步：验证两类模型 {#step-4-verify-both-models}

获取已部署的 LiteLLM 代理服务：

```bash
kubectl -n "$NAMESPACE" get svc
```

预期输出：

```text
NAME       TYPE        CLUSTER-IP     EXTERNAL-IP   PORT(S)    AGE
litellm    ClusterIP   <cluster-ip>   <none>        4000/TCP   12h
postgres   ClusterIP   None           <none>        5432/TCP   12h
redis      ClusterIP   <cluster-ip>   <none>        6379/TCP   12h
```

### 1. 建立端口转发 {#1-establish-port-forwarding}

在另一个终端中转发 4000 端口：

```bash
kubectl -n "$NAMESPACE" port-forward deploy/litellm 4000:4000
```

### 2. 获取已配置的模型（`/v1/models`） {#2-retrieve-configured-models-v1models}

获取管理员主密钥，并查询 `/v1/models` 端点：

```bash
MK=$(kubectl -n "$NAMESPACE" get secret litellm-secrets -o jsonpath='{.data.master-key}' | base64 -d)

curl -s http://127.0.0.1:4000/v1/models -H "Authorization: Bearer $MK" | jq .
```

预期输出同时包含自托管模型和外部模型：

```json
{
  "object": "list",
  "data": [
    {
      "id": "qwen/qwen3-32B",
      "object": "model",
      "created": 1677610602,
      "owned_by": "openai"
    },
    {
      "id": "qwen/qwen3-32b-standalone",
      "object": "model",
      "created": 1677610602,
      "owned_by": "openai"
    },
    {
      "id": "gemini-flash",
      "object": "model",
      "created": 1677610602,
      "owned_by": "openai",
      "max_input_tokens": 1048576,
      "max_output_tokens": 65535
    }
  ]
}
```

### 3. 生成带预算和限流的限定范围虚拟密钥 {#3-generate-scoped-virtual-key-with-budget-and-rate-limits}

使用管理员主密钥创建一个限定范围的虚拟密钥，限制可访问的模型，并设置 10 美元的预算上限和 60 RPM 的限流：

```bash
KEY_RESP=$(curl -s http://127.0.0.1:4000/key/generate \
  -H "Authorization: Bearer $MK" \
  -H "Content-Type: application/json" \
  -d '{
    "models": ["qwen/qwen3-32B", "gemini-flash"],
    "max_budget": 10.0,
    "rpm_limit": 60,
    "duration": "30d",
    "user_id": "team-analytics"
  }')

echo "$KEY_RESP" | jq .

# 导出生成的虚拟密钥，供客户端推理使用：
export VIRTUAL_KEY=$(echo "$KEY_RESP" | jq -r .key)
```

预期输出：

```json
{
  "key": "<generated-virtual-key>",
  "max_budget": 10.0,
  "spend": 0.0,
  "models": ["qwen/qwen3-32B", "gemini-flash"],
  "rpm_limit": 60,
  "duration": "30d",
  "user_id": "team-analytics"
}
```

### 4. 使用虚拟密钥测试推理请求 {#4-test-inference-requests-with-virtual-key}

客户端应用使用其限定范围的虚拟密钥（`$VIRTUAL_KEY`），而不是管理员主密钥。

#### A. 调用自托管模型（经由 llm-d 的 `qwen/qwen3-32B`） {#a-call-self-hosted-model-qwenqwen3-32b-via-llm-d}

```bash
curl -s -m 45 http://127.0.0.1:4000/v1/chat/completions \
  -H "Authorization: Bearer $VIRTUAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen/qwen3-32B",
    "messages": [{"role": "user", "content": "hi"}],
    "max_tokens": 16
  }' | jq .
```

预期输出（包含 `vllm` 指纹，确认请求经由 llm-d 执行）：

```json
{
  "id": "<response-id>",
  "object": "chat.completion",
  "created": 1783624185,
  "model": "qwen/qwen3-32B",
  "system_fingerprint": "vllm-0.23.0-tp2-f1888500",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "<think>\nOkay, the user sent \"hi\". That's pretty casual. I"
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

#### B. 调用外部模型（经由 Google AI Studio API 的 `gemini-flash`） {#b-call-external-model-gemini-flash-via-google-ai-studio-api}

```bash
curl -s -m 45 http://127.0.0.1:4000/v1/chat/completions \
  -H "Authorization: Bearer $VIRTUAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-flash",
    "messages": [{"role": "user", "content": "hi"}],
    "max_tokens": 16
  }' | jq .
```

预期输出（由 Gemini 返回、并转换为 OpenAI 格式）：

```json
{
  "id": "<response-id>",
  "object": "chat.completion",
  "created": 1783624118,
  "model": "gemini-flash",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! How can I help you today?"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 2,
    "completion_tokens": 9,
    "total_tokens": 11
  }
}
```

### 5. 检查花费跟踪与剩余预算 {#5-check-spend-tracking-and-remaining-budget}

通过 LiteLLM 的密钥管理端点查询数据库，验证花费审计：

```bash
curl -s "http://127.0.0.1:4000/key/info?key=$VIRTUAL_KEY" \
  -H "Authorization: Bearer $MK" | jq .
```

预期输出：

```json
{
  "key": "<generated-virtual-key>",
  "info": {
    "spend": 0.00042,
    "max_budget": 10.0,
    "models": ["qwen/qwen3-32B", "gemini-flash"],
    "rpm_limit": 60,
    "user_id": "team-analytics"
  }
}
```

---

## 清理 {#cleanup}

移除 LiteLLM 代理、独立的 Redis 协调存储、PostgreSQL 数据库以及所有相关资源：

```bash
helm uninstall litellm -n "$NAMESPACE"
kubectl delete -n "$NAMESPACE" -f redis.yaml -f postgres.yaml
kubectl delete namespace "$NAMESPACE"
```
