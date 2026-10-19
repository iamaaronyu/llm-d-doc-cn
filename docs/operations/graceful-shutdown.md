# 优雅关闭与请求排空

## 概述 {#overview}

当 llm-d 部署中的某个 Pod 被终止时——无论是缩容、滚动更新还是节点排空——进行中的推理请求都面临风险。由于推理请求运行时间长、计算量大，突然杀掉 Pod 可能会让原本几秒钟后就能完成的请求失败。

优雅地处理终止涉及**两个层面**：

1. **路由层**（路由器 / 端点选择器）——停止向正在终止的 Pod 发送*新*请求，并排空仍在调度器中排队的请求。
2. **模型服务器层**（vLLM）——在进程退出之前，让*进行中*的推理请求完成（或在有限的时间窗口内排空）。

本指南介绍**一般（非分离式）服务**的优雅关闭。对于 prefill/decode 分离——进行中的请求横跨多个服务器、KV 缓存分布在多个实例上——请参阅[分离式服务运维（vLLM）](disaggregation/vllm.md)。

## Kubernetes Pod 终止流程 {#the-kubernetes-pod-termination-sequence}

llm-d 依赖标准的 [Kubernetes Pod 终止流程](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination)：

1. **触发终止**——Pod 的状态被设置为 `Terminating`。
2. **更新 `InferencePool`**——该 Pod 被从其关联 `InferencePool` 的端点中移除，因此路由器不再向它路由**新**流量。（对于标准 Kubernetes 对象，这相当于从 `Service` 中移除。）
3. **`preStop` 钩子**——如果定义了，执行容器的 `preStop` 钩子。
4. **`SIGTERM`**——Kubernetes 向每个容器的主进程发送 `SIGTERM`。
5. **终止宽限期**——Pod 有 `terminationGracePeriodSeconds`（默认 **30 秒**）的时间退出。如果到期仍未退出，Kubernetes 会发送 `SIGKILL` 强制终止。

新流量在第 2 步就被自动处理了。本指南其余部分讨论的是 `SIGTERM` 到达时**已经在进行中**的请求会怎样。

## 排空模型服务器（vLLM） {#draining-the-model-server-vllm}

vLLM 如何响应 `SIGTERM`，决定了进行中的请求是被排空还是被丢弃：

- **默认**——vLLM 立即中止（`abort`）进行中的请求并退出。这些请求会以错误状态码失败。
- **使用 `--shutdown-timeout N`**——vLLM 会捕获 `SIGTERM`，并在最多 `N` 秒内继续处理当前正在运行的请求。超时后，仍在进行中的请求会被中止（`abort`）并返回错误。

:::info
`terminationGracePeriodSeconds` 必须**大于** `--shutdown-timeout`（再加上为 `preStop` 钩子和进程清理预留的少量余量）。否则 Kubernetes 会在排空完成之前发送 `SIGKILL`，优雅关闭的时间窗口就无法被充分利用。
:::


## 客户端断开时的请求取消 {#request-cancellation-on-client-disconnect}

与关闭无关，vLLM 等模型服务器支持**请求取消**：当客户端断开连接时，进行中的请求会被释放，而不是继续运行到完成。请求断开时，vLLM 会触发其 `abort` 代码路径，释放该请求占用的 KV 缓存和计算资源。

这在关闭和滚动更新期间很重要：对正在排空的 Pod 发起重试的客户端（或网关）应当断开原始请求，以便及时回收其资源，而不是一直占用到请求自行完成。

对于分离式场景——被取消的请求可能在另一个 prefill 实例上持有 KV 块——请参阅[请求取消](disaggregation/vllm.md#request-cancellation)。

## 排空路由层（EPP） {#draining-the-routing-layer-epp}

端点选择器（EPP）会在把请求分发给模型服务器之前对其排队。在优雅关闭期间，EPP 的流量控制器会**以可重试的 `503 Service Unavailable` 驱逐排队中的请求**（结果为 `rejected-shutting-down`），表明这是暂时不可用，从而让客户端和上游网关**重试**，而不是把排空视为严重故障。

这些可重试的语义只在 EPP 仍可通过其 `ext_proc` 流访问时才适用。一旦 EPP 进程真正消失，结果就由 `InferencePool` 的 [`failureMode`](../architecture/core/inferencepool.md) 决定。关于高可用路由器配置以及 leader 拆除期间的 `failOpen` 行为，请参阅[路由器运维](router.md)。

完整的流量控制结果码，请参阅[流量控制](../architecture/core/router/epp/flow-control.md)。

## 推荐配置 {#recommended-configuration}

为优雅排空配置的模型服务器 Pod：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: vllm
spec:
  # 必须大于 --shutdown-timeout，并为 preStop 和清理预留余量。
  terminationGracePeriodSeconds: 120
  containers:
  - name: vllm
    image: ghcr.io/llm-d/llm-d:latest
    args:
    - "--shutdown-timeout"
    - "90"          # 收到 SIGTERM 后最多排空 90 秒的进行中请求。
    ports:
    - containerPort: 8000
      protocol: TCP
    # 就绪探针控制流量；参见 readiness-probes.md。
    readinessProbe:
      httpGet:
        path: /v1/models
        port: 8000
      periodSeconds: 5
      timeoutSeconds: 2
      failureThreshold: 3
```

建议：

- 把 `--shutdown-timeout` 设置为大约你希望在排空时允许完成的请求的 p99 时长。
- 把 `terminationGracePeriodSeconds` 设置得比它更高并留出余量（这里是 120 秒对 90 秒）。
- 配合模型感知的就绪探针使用，确保只有在模型加载完成后 Pod 才被标记为 `Ready`——参见[就绪探针](readiness-probes.md)。

## 验证 {#verification}

发送一个长时间运行的请求，然后删除 Pod，确认该请求能够完成而不是失败：

```bash
# 在后台针对目标 Pod 启动一个长时间的生成任务。
# 然后触发终止：
kubectl delete pod -n llm-d <pod-name>

# 在模型服务器日志中观察排空过程。
kubectl logs -n llm-d <pod-name> --tail=50 | grep -iE "shutdown|drain|abort|SIGTERM"

# 观察 Pod 保持在 Terminating 状态，直到排空窗口结束。
kubectl get pod -n llm-d <pod-name> -w
```

设置 `--shutdown-timeout` 后的预期行为：

1. Pod 进入 `Terminating`；它被从 `InferencePool` 中移除（不再有新流量）。
2. vLLM 捕获 `SIGTERM` 并继续处理进行中的请求。
3. 进行中的请求成功完成。
4. Pod 在 `terminationGracePeriodSeconds` 到期之前退出（没有 `SIGKILL`）。

## 故障排查 {#troubleshooting}

**缩容/发布时进行中的请求仍然失败**

- 确认设置了 `--shutdown-timeout`；没有它，vLLM 会立即中止。
- 确认 `terminationGracePeriodSeconds > --shutdown-timeout`；否则 `SIGKILL` 会在排空中途触发。

**关闭期间客户端看到的是硬错误而不是重试**

- 确保客户端/网关把 `503` 视为可重试——EPP 以可重试的 `503` 排空排队中的请求，而不是致命错误。
- 检查 `InferencePool` 的 `failureMode`，了解 EPP 消失后的行为。

## 更多资源 {#additional-resources}

- [分离式服务运维（vLLM）](disaggregation/vllm.md)
- [就绪探针](readiness-probes.md)
- [路由器运维](router.md)
- [流量控制](../architecture/core/router/epp/flow-control.md)
- [Kubernetes Pod 终止](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination)
