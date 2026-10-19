# 网关指南

本目录包含把 Kubernetes Gateway 部署为 **llm-d 路由器**代理的指南。关于这项能力的更多信息，请参阅[网关模式下的 llm-d 路由器](../../architecture/core/router/proxy.md#gateway-mode-inference-gateway)。

## 为什么需要 Gateway？ {#why-do-you-need-a-gateway}

**llm-d 路由器**为[兼容的 Gateway 提供方](https://gateway-api-inference-extension.sigs.k8s.io/implementations/gateways/)扩展了在多个模型服务器副本之间对 LLM 流量进行负载均衡的优化能力。

与 Gateway 集成后，自托管的模型可以通过[多种网络拓扑](https://gateway-api.sigs.k8s.io/concepts/use-cases/)对外暴露，包括：

* 面向互联网的服务
* 集群内部
* 通过服务网格

并能利用 Gateway 的关键特性，例如：

* 流量拆分，用于新模型的渐进式发布
* 对查询和响应进行 TLS 加密

通过与 Gateway 集成——而不是开发 llm-d 专用的代理层——llm-d 可以利用成熟代理的高性能，并借助现有的运维工具管理发往服务的流量。兼容的 Gateway 实现在底层可能使用 [Envoy](https://www.envoyproxy.io/) 或其他高性能数据面。

## 支持的 Gateway 提供方 {#supported-gateway-providers}

llm-d 要求你选择一个[支持 Gateway API Inference Extension 的 Gateway 实现](https://gateway-api-inference-extension.sigs.k8s.io/implementations/gateways/)。你的基础设施可能已经提供了默认的兼容实现，你也可以选择在集群上部署一个网关实现。

* [GKE Gateway](./gke.md)——GKE 通过 GKE Gateway 控制器实现 Gateway API，它为 GKE 集群中的 Pod 预配 Google Cloud 负载均衡器。GKE Gateway 控制器支持按权重拆分流量、流量镜像、高级路由、多集群负载均衡等。[GKE 官方文档](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/gateway-api)。
* [Istio](./istio.md)——Istio 是开源的服务网格和网关实现。它为集群入口流量控制提供了完全符合规范的 Kubernetes Gateway API 实现。[Istio 官方文档](https://istio.io/)
* [Agentgateway](./agentgateway.md)——Agentgateway 是基于 Rust 的高性能 AI 网关，面向 LLM、MCP 和 A2A 工作负载，也可以作为 Gateway API 和推理网关的实现。[Agentgateway 官方文档](https://agentgateway.dev/)。
* [Envoy AI Gateway](./envoy-ai-gateway.md)——Envoy AI Gateway 是一个开源项目，使用 Envoy Gateway 处理从应用客户端到 GenAI 服务的请求流量，也可以作为 Gateway API 和推理网关的实现。[Envoy AI Gateway 官方文档](https://aigateway.envoyproxy.io/)。

:::note
搭建 Gateway 通常需要集群管理员权限。
:::


## 其他提供方 {#other-providers}

对于上面未列出的其他[兼容 Gateway 实现](https://gateway-api-inference-extension.sigs.k8s.io/implementations/gateways/)，请按照所选 Gateway 提供方的安装说明进行操作。确保已安装 Gateway API 和 Gateway API Inference Extension 所需的 CRD。
