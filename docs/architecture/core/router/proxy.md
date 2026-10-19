# 代理

代理是 llm-d 路由器中推理请求的入口，它接收客户端流量，并借助 EPP 把请求路由到最优的模型服务器。支持的实现范围广泛，既包括自行管理的应用负载均衡器（例如 Istio、agentgateway、Envoy AI Gateway），也包括符合规范的云托管服务，例如 Google Cloud 的应用负载均衡器。它支持两种主要部署模式：**独立模式（Standalone Mode）**，即自行管理的代理与 EPP 运行在同一个 Pod 中；以及**网关模式（Gateway Mode）**，通过 Kubernetes Gateway API 与 L7 负载均衡器集成。

## 功能 {#functionality}

llm-d 利用 [External Processing（外部处理）](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/ext_proc_filter)，为生产级代理扩展 llm-d EPP 中实现的“LLM 推理感知”请求路由。通过这种方式，llm-d 复用了 Kubernetes 生态中丰富的高性能、生产级代理技术。

代理的工作是：

- **接收来自客户端的推理请求**（兼容 OpenAI 的 API）
- 通过 ext-proc **咨询 EPP**，确定最优的后端端点
- 把请求**路由**到选中的模型服务器 Pod
- 把响应**流式**返回给客户端

### 请求流程（两种模式相同） {#request-flow-both-modes}

无论采用哪种部署模式，请求流程都是一样的：

1. 客户端向代理发送推理请求
2. 代理的 ext-proc 过滤器调用 EPP
3. EPP 使用其插件流水线（处理器、过滤器、打分器、选择器）评估端点
4. EPP 返回选中的端点地址
5. 代理把请求转发到该模型服务器 Pod
6. 模型服务器把响应发回代理（代理会把结果流经 EPP 进行后处理）

---

## 独立模式 {#standalone-mode}

独立模式把代理作为 EPP 的 Sidecar 部署，提供一种轻量、灵活的部署方式，无需 Gateway API 基础设施。

### 适用场景 {#when-to-use}

独立部署适用于 Gateway API 这套机制会带来过多运维负担的工作负载，包括：

- 使用传统 Ingress 控制器的集群。
- 基本测试和本地评估。
- 批量推理工作负载。
- RL 后训练流水线。

### 架构 {#architecture}

在独立模式下，符合规范的代理与 EPP 运行在同一个 Pod 中。

- **通信**：`ext-proc` 通信通过 `localhost` 进行。
- **简化**：不需要 `Gateway`、`HTTPRoute` 或网关控制器。
- **访问**：流量直接发送到 EPP Pod 对外暴露的端口。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)">
    <img src="/img/versioned/0.10/assets/standalone-design.svg" alt="独立模式设计">
  </picture>
</p>

---

## 网关模式（推理网关） {#gateway-mode-inference-gateway}

网关模式也称为**推理网关（Inference Gateway）**，它利用官方 Kubernetes Gateway API 项目——该项目专注于 L4 和 L7 网络，代表了下一代 Kubernetes 负载均衡和服务网格 API。

### 适用场景 {#when-to-use-1}

网关模式面向有以下需求的生产环境：

- **共享基础设施**：单个共享 Gateway 可以同时承载推理工作负载（以 `InferencePool` 表示）和传统应用（标准 Kubernetes `Service` 对象）的多条 HTTP/gRPC 路由。
- 与云原生 L7 网络方案（Istio、GKE Gateway、agentgateway、Envoy AI Gateway）集成。
- 多集群负载均衡。
- 高级流量管理（按权重拆分、流量镜像）。
- 在严格控制下向外部工作负载暴露端点。

### 架构 {#architecture-1}

[Gateway API Inference Extension（GAIE）](https://gateway-api-inference-extension.sigs.k8s.io/)通过 [External Processing](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/ext_proc_filter) 扩展 Gateway API，把 LLM 感知的负载均衡注入到 Gateway 提供方提供的生产级网络之中。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)">
    <img src="/img/versioned/0.10/assets/gateway-design.svg"  alt="网关模式设计">
  </picture>
</p>

要把 **InferencePool**（以及它所选择的 EPP）连接到 **Gateway**，需要使用一个把该资源池作为后端引用的 **HTTPRoute**。网关模式的一大优势是能够承载复杂的路由拓扑：单个 `Gateway` 可以承载多个 `HTTPRoute` 对象，每条路由又可以配置多个 **InferencePool** 后端（例如用于金丝雀发布或流量拆分）或一个标准的 Kubernetes **Service**。

下图展示了网关模式下的层级路由结构，说明请求如何被匹配并分发到多个 InferencePool 和传统 Service：

```text
                          +-----------------------+
                          |        Gateway        |
                          |    （工业级代理）     |
                          +-----------+-----------+
                                      |
                  ____________________|____________________
                 |                                         |
          路径/请求头匹配                           路径/请求头匹配
         +-------v-------+                         +-------v-------+
         |   HTTPRoute   |                         |   HTTPRoute   |
         |   （推理）    |                         |   （传统）    |
         +-------+-------+                         +-------+-------+
                 |                                         |
         ________|________                                 |
        |                 |                                |
    匹配/权重         匹配/权重                        匹配/权重
 +-----v-------+   +-----v-------+                 +-------v-------+
 |InferencePool|   |InferencePool|                 |    Service    |
 |     (A)     |   |     (B)     |                 |    （Web）    |
 +-------------+   +-------------+                 +---------------+
```

流量首先与 `HTTPRoute` 规则进行匹配（通常使用**路径**或**请求头**匹配）。如果该规则中选中的后端是 `InferencePool`，请求会被暂存，同时咨询为该 `InferencePool` 配置的 EPP，以获得针对推理优化的路由决策。

<table>
<tr>
<td><b>Gateway 示例</b></td>
<td><b>HTTPRoute 示例</b></td>
</tr>
<tr>
<td valign="top">

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: my-gateway
spec:
  gatewayClassName: istio
  listeners:
    - name: http
      protocol: HTTP
      port: 80
```

</td>
<td valign="top">

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: my-http-route
spec:
  parentRefs:
    - group: gateway.networking.k8s.io
      kind: Gateway
      name: my-gateway
  rules:
    - backendRefs:
        - group: inference.networking.k8s.io
          kind: InferencePool
          name: my-infpool
          port: 8000
      matches:
        - path:
            type: PathPrefix
            value: /
```

</td>
</tr>
</table>

### 部署指南 {#deployment-guides}

llm-d 为以下 Gateway 提供了[网关模式部署指南](../../../infrastructure/gateway/README.md)：

- [Istio](../../../infrastructure/gateway/istio.md)
- [GKE Gateway](../../../infrastructure/gateway/gke.md)
- [agentgateway](../../../infrastructure/gateway/agentgateway.md)
- [Envoy AI Gateway](../../../infrastructure/gateway/envoy-ai-gateway.md)
