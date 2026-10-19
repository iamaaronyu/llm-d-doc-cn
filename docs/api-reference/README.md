# API 参考

## 核心 Kubernetes API {#core-kubernetes-apis}

以下 Kubernetes API 定义在 `inference.networking.k8s.io`（v1）和 `llm-d.ai`（v1alpha2）两个 API 组中。

| 资源 | API 组 | 版本 | 说明 |
| --- | --- | --- | --- |
| [InferencePool](inferencepool.md) | `inference.networking.k8s.io` | `v1` | 定义一组推理端点（模型服务器），用于配置**端点选择器（EPP）**和 Gateway，实现针对推理优化的路由。 |
| [InferenceObjective](inferenceobjective.md) | `llm-d.ai` | `v1alpha2` | 为资源池内特定模型工作负载定义性能目标（优先级、延迟）。 |
| [InferenceModelRewrite](inferencemodelrewrite.md) | `llm-d.ai` | `v1alpha2` | 指定改写请求体中模型名称的规则，支持流量拆分和金丝雀发布。 |

## 组件配置 {#component-configuration}

这些结构定义了项目组件的内部配置，通常通过 ConfigMap 或本地文件提供，而不是作为独立的 Kubernetes 对象。

| 结构 | API 组 | 版本 | 说明 |
| --- | --- | --- | --- |
| [EndpointPickerConfig](endpointpickerconfig.md) | `llm-d.ai` | `v1alpha1` | 定义**端点选择器（EPP）**的内部配置，包括插件和请求调度 Profile。 |

## 可识别的 HTTP 请求头 {#recognized-http-headers}

* [EPP HTTP 请求头参考](epp-http-headers.md)：EPP 会检查特定的 HTTP 请求头，用于管理推理请求的流量控制和可观测性。

## 支持的请求 API {#supported-request-apis}

* [EPP HTTP API 参考](epp-http-apis.md)：OpenAI 的 Chat、Anthropic 的 Message 以及 vLLM 的 Generate 等 HTTP API。
* [EPP gRPC API 参考](epp-grpc-apis.md)：vLLM 的 gRPC Generate 等 gRPC API。

## 另请参阅 {#see-also}

* [术语表](glossary.md)：本项目中使用的关键术语和概念的定义。
