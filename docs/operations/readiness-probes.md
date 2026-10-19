# vLLM 模型感知的就绪探针

## 概述 {#overview}

要为 vLLM 推理容器做好健康检查，需要理解三个不同的生命周期阶段：

1. **容器运行中**——Kubernetes 容器生命周期
2. **API 服务器就绪**——vLLM 兼容 OpenAI 的 API 服务器已开始接受连接
3. **模型已加载**——模型已加载完毕，可以处理推理请求

本指南说明如何配置 Kubernetes 探针，确保只有在模型完全加载并可用之后，Pod 才会被标记为 Ready。

## 问题描述 {#problem-statement}

部署 vLLM 推理服务器时，从容器启动到模型完全加载之间存在相当长的时间差。只使用基础的健康检查可能导致：

- 流量被过早路由到尚未准备好处理请求的 Pod
- 在模型加载阶段请求失败
- 部署流水线中需要加入随意设定的等待时间
- 端到端测试和 CI/CD 流程不可靠

vLLM 的 `/health` 端点只表示服务器进程正在运行，**并不**表示模型已加载并可以提供服务。

## 解决方案：模型感知的 HTTP 探针 {#solution-model-aware-http-probes}

结合 vLLM 兼容 OpenAI 的 API 端点使用 Kubernetes HTTP 探针，实现模型感知的就绪检查。

### 推荐的探针配置 {#recommended-probe-configuration}

```yaml
containers:
- name: vllm
  ports:
  - containerPort: 8000  # decode Pod 为 8200
    protocol: TCP

  # 启动探针：在初始化期间等待模型加载
  # 防止存活/就绪探针过早触发
  startupProbe:
    httpGet:
      path: /v1/models
      port: 8000
    initialDelaySeconds: 15    # 第一次探测前的等待时间
    periodSeconds: 30           # 启动期间的探测频率
    timeoutSeconds: 5           # HTTP 请求超时
    failureThreshold: 60        # 最大尝试次数（30s * 60 = 最长 30 分钟启动时间）

  # 存活探针：服务器进程是否存活？
  # 简单的健康检查，失败时重启容器
  livenessProbe:
    httpGet:
      path: /health
      port: 8000
    periodSeconds: 10           # 每 10 秒检查一次
    timeoutSeconds: 5
    failureThreshold: 3         # 连续 3 次失败后重启

  # 就绪探针：模型是否已加载就绪？
  # 控制流量路由，失败时从服务中摘除
  readinessProbe:
    httpGet:
      path: /v1/models
      port: 8000
    periodSeconds: 5            # 频繁检查以便快速恢复
    timeoutSeconds: 2
    failureThreshold: 3
```

### 按角色配置端口 {#port-configuration-by-role}

不同角色的 Pod 使用不同的端口：

| Pod 角色 | 端口 | 说明 |
| ---------- | ------ | ------------- |
| Prefill | 8000 | 直接访问 vLLM API |
| Decode | 8200 | 经由 Sidecar 代理（8200 → 8000） |
| 独立部署 | 8000 | 单节点部署 |

请始终让探针配置与 Pod 的服务端口一致。

## 工作原理 {#how-it-works}

### `/health` 端点 {#health-endpoint}

`/health` 端点提供基础的存活检查：

```bash
$ curl http://localhost:8000/health
{}
```

**行为：**

- vLLM 服务器启动后立即返回 `200 OK`
- **不会**等待模型加载
- 仅用于 `livenessProbe`

### `/v1/models` 端点（兼容 OpenAI） {#v1models-endpoint-openai-compatible}

`/v1/models` 端点能够感知模型，反映真正的就绪状态：

```bash
$ curl http://localhost:8000/v1/models
{
  "object": "list",
  "data": [
    {
      "id": "meta-llama/Llama-3.1-8B-Instruct",
      "object": "model",
      "created": 1704321600,
      "owned_by": "vllm"
    }
  ]
}
```

**行为：**

- 模型加载期间返回 `503` 或拒绝连接
- 就绪后返回带有模型元数据的 `200 OK`
- 非常适合用于 `startupProbe` 和 `readinessProbe`

### 探针生命周期 {#probe-lifecycle}

```text
容器启动
      ↓
[在 /v1/models 上执行 startupProbe]
  ↓（间隔 30 秒，最长 30 分钟）
  ✓ 模型已加载 → 启动完成
      ↓
[在 /health 上执行 livenessProbe] ← 服务器崩溃时重启
[在 /v1/models 上执行 readinessProbe] ← 就绪后路由流量
```

## 收益 {#benefits}

### HTTP 探针与 Exec 探针对比 {#http-probes-vs-exec-probes}

**HTTP 探针（推荐）：**

- ✅ 轻量，没有 exec 开销
- ✅ 与云负载均衡器兼容
- ✅ 原生的 Kubernetes 集成
- ✅ 更好的可观测性和指标
- ✅ 复用现有的 vLLM 端点

**Exec 探针（旧方式）：**

- ❌ 开销更高（每次探测都要 fork/exec）
- ❌ 与许多云负载均衡器不兼容
- ❌ 需要在容器中放置自定义脚本
- ⚠️ 调试和维护更复杂

### 对生产部署的好处 {#for-production-deployments}

- ✅ 防止过早路由流量
- ✅ 避免启动期间的请求失败
- ✅ 支持安全的滚动更新
- ✅ 更快发现不健康的 Pod
- ✅ 更好地与服务网格集成

### 对端到端测试的好处 {#for-e2e-testing}

- ✅ 不再需要随意设定的等待时间
- ✅ 测试执行更快
- ✅ 测试结果更可靠
- ✅ 更好的错误检测

## 示例 {#examples}

### Wide Endpoint 部署 {#wide-endpoint-deployment}

示例来自 `guides/wide-ep/manifests/modelserver/base/decode.yaml`：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: vllm-decode
spec:
  containers:
  - name: vllm
    image: ghcr.io/llm-d/llm-d:latest
    ports:
    - containerPort: 8200
      protocol: TCP

    startupProbe:
      httpGet:
        path: /v1/models
        port: 8200
      initialDelaySeconds: 30
      periodSeconds: 10
      timeoutSeconds: 5
      failureThreshold: 60

    livenessProbe:
      httpGet:
        path: /health
        port: 8200
      periodSeconds: 30
      timeoutSeconds: 5
      failureThreshold: 3

    readinessProbe:
      httpGet:
        path: /v1/models
        port: 8200
      periodSeconds: 10
      timeoutSeconds: 5
      failureThreshold: 3
```

## 测试探针 {#testing-probes}

### 手动测试 {#manual-testing}

在运行中的 Pod 内直接测试这些端点：

```bash
# 获取 Pod 名称
POD=$(kubectl get pods -n llm-d -l app=vllm -o name | head -1)

# 测试存活端点
kubectl exec -n llm-d $POD -- curl -sf http://localhost:8000/health

# 测试就绪端点
kubectl exec -n llm-d $POD -- curl -sf http://localhost:8000/v1/models | jq '.'
```

### 验证 {#verification}

在 Kubernetes 中检查探针状态：

```bash
# 观察 Pod 就绪状态
kubectl get pods -n llm-d -w

# 检查探针配置
kubectl describe pod -n llm-d $POD | grep -A 10 "Liveness:"

# 查看与探针相关的事件
kubectl get events -n llm-d --field-selector involvedObject.name=${POD##*/}
```

预期行为：

1. Pod 启动，进入 `Running` 状态
2. 启动探针反复检查 `/v1/models`（间隔 30 秒）
3. 模型加载完成后，启动探针成功
4. 就绪探针接管，Pod 变为 `Ready`
5. 流量被路由到该 Pod
6. 存活探针持续监控服务器健康状况

## 故障排查 {#troubleshooting}

### Pod 一直处于未就绪状态 {#pod-stuck-in-not-ready}

```bash
# 检查启动探针状态
kubectl describe pod -n llm-d $POD | grep -A 5 "Startup:"

# 检查模型是否加载缓慢
kubectl logs -n llm-d $POD | grep -i "loading model"

# 手动测试端点
kubectl exec -n llm-d $POD -- curl -v http://localhost:8000/v1/models
```

**常见原因：**

- 模型下载耗时超过 `failureThreshold` 允许的范围
- 资源不足（CPU/内存/GPU）
- 探针配置中的端口错误
- 网络问题导致无法下载模型

**解决方法：**

- 增大 `startupProbe` 的 `failureThreshold` 或 `periodSeconds`
- 使用 init 容器或持久卷预先下载模型
- 确认 Pod 分配了足够的资源
- 检查探针配置是否与实际服务端口一致

### 启动后探针失败 {#probe-failures-after-startup}

```bash
# 查看最近的探针失败
kubectl get events -n llm-d | grep -i probe

# 查看 Pod 日志中的错误
kubectl logs -n llm-d $POD --tail=100
```

**常见原因：**

- vLLM 服务器崩溃（存活探针失败）
- 模型被卸载或损坏（就绪探针失败）
- 资源耗尽（OOM、GPU 错误）
- 网络连通性问题

## 更多资源 {#additional-resources}

- [Kubernetes 探针配置](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)
- [vLLM 兼容 OpenAI 的服务器](https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html)
- [llm-d 入门](https://github.com/llm-d/llm-d/tree/v0.10.0/README.md)
- [llm-d 监控指南](observability/README.md)

## 相关 Issue {#related-issues}

- [vLLM #6073](https://github.com/vllm-project/vllm/issues/6073)——请求增加专门的 `/ready` 端点
- vLLM 目前依靠 `/v1/models` 进行模型感知的就绪检查
