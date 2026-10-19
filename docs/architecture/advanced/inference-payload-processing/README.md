# 推理载荷处理器（IPP）

## 功能 {#functionality}

**推理载荷处理器（Inference Payload Processor，IPP）**是一个可插拔框架，用于在路由决策之前和之后处理推理请求与响应的载荷。

IPP 支持：

* **请求处理**——在做出路由决策之前，检查并修改请求头、请求体或 trailer。
* **响应处理**——在模型服务器响应之后，检查并修改响应头、响应体或 trailer。

常见用例包括模型感知路由（从请求体中提取模型名称）、护栏、内容过滤、载荷转换以及可观测性钩子。

## 集成 {#integration}

IPP 通过 Envoy 的 [External Processing（ext-proc）](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/ext_proc_filter)协议与代理集成。

IPP 和 EPP 都参与路由决策：

| 组件 | 路由范围 | 决策 |
|-----------|---------------|----------|
| **IPP** | 资源池级 | 选哪个 InferencePool？ |
| **EPP** | 端点级 | 选资源池中的哪个 Pod？ |

## 请求流程 {#request-flow}

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)">
    <img src="/img/versioned/0.10/assets/ipp-request-flow.svg" alt="IPP 请求流程">
  </picture>
</p>

1. **客户端**向代理发送推理请求。
2. **代理**通过 ext-proc 调用 IPP。
3. **IPP** 通过其配置的插件流水线处理请求，并返回所有改动（请求头、请求体修改）。
4. **代理**应用这些改动，并路由到相应的 InferencePool。
5. **EPP** 在资源池中选出最优的 Pod。
6. **模型服务器**处理请求并返回响应。

## 插件架构 {#plugin-architecture}

IPP 使用基于 Profile 的插件架构：

* **插件（Plugins）**——执行特定处理任务的模块化单元（例如提取字段、设置请求头、过滤模型）。
* **Profile**——具名的插件集合，为不同类型的请求定义处理流水线。
* **Profile 选择器（Profile Picker）**——根据请求属性选择要执行的 Profile。

处理流水线按以下顺序执行：

```
PreProcessing → ProfilePicker → Profile 请求插件 → [模型服务器] → Profile 响应插件 → PostProcessing
```

详细的插件文档和配置，请参阅 [IPP 仓库](https://github.com/llm-d/llm-d-inference-payload-processor)。

## 运维 {#operations}

### 部署 {#deployment}

IPP 以独立的 Kubernetes Deployment 形式部署。Helm Chart 会根据你的环境自动配置相应的代理集成：

* **Istio**——创建一个 EnvoyFilter，把 ext_proc 插入 Gateway
* **GKE**——创建一个 GCPRoutingExtension 资源

### 监控 {#monitoring}

IPP 在 9090 端口的 `/metrics` 路径暴露兼容 Prometheus 的指标，提供请求处理和插件执行延迟的可见性。

## 延伸阅读 {#further-reading}

* [IPP 仓库](https://github.com/llm-d/llm-d-inference-payload-processor)——源代码、配置参考和插件文档
* [多模型路由](../../../well-lit-paths/foundations/multi-model-routing.md)——使用 IPP 实现模型感知路由
