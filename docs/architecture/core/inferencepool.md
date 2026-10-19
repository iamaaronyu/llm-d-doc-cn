# InferencePool

`InferencePool` 是连接 Gateway、端点策略提供者（EPP）和一组模型服务器实例的核心资源。它是端点发现以及服务网格/网关集成两方面的唯一事实来源。

## 功能概述 {#functional-overview}

`InferencePool` 在推理基础设施中承担两个主要角色：

1. **为 EPP 提供端点发现：**它定义 EPP 应如何查找和监控有资格处理请求的模型服务器 Pod。
2. **为 Gateway 提供服务集成：**它为 Gateway 控制器提供必要的元数据，使其能够定位 EPP，并把 EPP 作为外部处理（`ext-proc`）服务接入代理。

## 架构与关系 {#architecture-and-relations}

下图展示了 `InferencePool` 资源如何参与 EPP 和 Gateway 控制器两者的控制路径：

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)">
    <img src="/img/versioned/0.10/assets/gateway-design.svg"  alt="InferencePool">
  </picture>
</p>

### 1. 端点发现（EPP 视角） {#1-endpoint-discovery-epp-perspective}

EPP 使用 `InferencePool` 发现可供选择的 Pod。

* **基于选择器的发现：**`InferencePool` 定义了一个 `selector`（标签匹配）。EPP 监视同一命名空间中与这些标签匹配的 Pod。
* **动态成员关系：**当模型服务器 Pod 扩缩容或其就绪状态发生变化时，EPP 会自动更新其内部的健康候选列表。
* **端口映射：**`InferencePool` 中的 `targetPorts` 告诉 EPP，被发现的 Pod 上哪些端口在监听推理流量（例如 vLLM 的 8000 端口）。

### 2. Gateway 集成（控制器视角） {#2-gateway-integration-controller-perspective}

当 `InferencePool` 被用作 `HTTPRoute` 中的 backendRef 时，Gateway 控制器会利用该资源配置底层代理。

* **EPP 连接：**`InferencePool` 中的 `endpointPickerRef`（或 `extensionRef`）指向 EPP 服务。Gateway 控制器根据这些信息配置代理的 `ext_proc` 过滤器，确保发往该资源池的每个请求都先经过 EPP 处理。
* **路由逻辑：**代理被配置为“暂存”请求并等待 EPP 的决策。随后，EPP 通过 `ext_proc` 协议告诉代理应由被发现资源池中的哪个具体 Pod IP 接收该请求。
* **故障处理：**`InferencePool` 中定义的 `failureMode`（例如 `FailOpen` 或 `FailClose`）告诉 Gateway 控制器，当 EPP 无响应时应如何配置代理的行为。

## 关键关系 {#key-relationships}

* **一对一映射：**通常，一个 `InferencePool` 对应一个模型的逻辑部署（例如 Gemma4），并由一个 EPP 部署提供服务。
* **解耦的扩缩：**模型服务器可以独立于 EPP 扩缩。`InferencePool` 确保 EPP 始终了解当前可用的端点集合。
* **命名空间作用域：**所有发现和引用（Pod、EPP Service 以及 InferencePool 本身）都严格限定在同一个 Kubernetes 命名空间内，以维持安全和隔离边界。
