# 端点选择器（EPP）

## 功能 {#functionality}

EPP 是 llm-d 部署的“大脑”。它专注于两个关键目标：

- **智能路由**——利用模型服务器 Pod 的内部状态（KV 缓存利用率、前缀缓存局部性、请求队列深度和活跃请求数），决定 InferencePool 中由哪个**模型服务器 Pod** 处理每个推理请求

- **公平性与优先级**——决定在任一时刻应运行哪些**推理请求**，从而把优先级各不相同的多个工作负载整合到同一组模型服务器上

EPP 是一个可扩展组件，通过 Envoy 的 [External Processing（ext-proc）](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/ext_proc_filter)协议与代理层集成。

:::note
项目提供了自动安装 Envoy 的工具。但如果你自行安装或配置，请注意唯一支持的 [request_body_mode 和 response_body_mode](https://www.envoyproxy.io/docs/envoy/latest/api-v3/service/ext_proc/v3/external_processor.proto) 是 `FULL_DUPLEX_STREAMED`
:::


当请求到达代理时，代理调用 EPP 选择后端端点，EPP 根据[端点选择协议（Endpoint Picking Protocol）](https://github.com/kubernetes-sigs/gateway-api-inference-extension/tree/main/docs/proposals/004-endpoint-picker-protocol)返回最优的 Pod 地址。

## 设计 {#design}

### 请求流程 {#request-flow}

下图展示了请求流经 EPP 插件流水线的端到端生命周期：

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)">
    <img src="/img/versioned/0.10/assets/epp-design.svg" alt="EPP 设计">
  </picture>
</p>

步骤如下：

1. **请求到达**——推理请求到达代理（Gateway）。
2. **外部处理**——代理通过 ext-proc 协议调用 EPP，把请求头和请求体传给 EPP。
3. **请求处理**——把请求（例如 OpenAI 格式、vLLM gRPC）解析为内部请求数据结构。
4. **流量控制**——如果启用，则对请求排队并区分优先级，在同一优先级内保证不同租户之间的公平性，并在资源池“饱和”时暂存请求。
5. **请求调度**——从可用的 InferencePool 中选择最优端点，即针对配置的一组调度插件（如过滤器和打分器）评估每个请求。
6. **请求代理**——EPP 把选中端点的地址返回给代理，代理随后把请求转发到相应的模型服务器端点。

**数据层（Data layer）**以异步方式运行：它监视 Kubernetes API 服务器中 InferencePool 和 Pod 等相关对象的更新，用于端点发现。它还负责探测模型服务器指标，并维护内部状态（例如前缀缓存树），为请求处理组件、流量控制和请求调度提供依据。

### 组件 {#components}

EPP 是模块化、可插拔的，由以下组件组成：

#### Ext-Proc 服务器 {#ext-proc-server}

Ext-Proc 服务器协议定义非常明确且具体，任何偏离都可能导致 EPP 无法使用或不稳定，因此不建议对其进行扩展。Ext-Proc 只是代理与 EPP 通信的标准接口。

#### 请求处理器（可扩展） {#request-handler-extensible}

**请求处理器（Request Handler）**是 EPP 中请求流程的第一步。它的主要职责是通过 Parser 插件把用户请求转换为 EPP 的内部数据结构。EPP 为 [OpenAI HTTP](https://developers.openai.com/api/reference/overview) 和 [vLLM gRPC](https://docs.vllm.ai/en/latest/api/vllm/entrypoints/grpc_server/) 等常见格式提供了开箱即用的解析器。

此外，用户还可以为自己的协议编写自定义解析器。EPP 的其余功能与原始请求协议无关，因此可以很容易地适配新的请求格式。

设计的更多细节请参阅[请求处理](request-handling.md)。

#### 流量控制（可扩展） {#flow-control-extensible}

流量控制的主要目的是管理请求的准入、排队和分发，在防止后端模型服务器过载的同时保证公平性和优先级。具体来说：

- 准入控制与限流：它不会任由推理资源池被压垮，而是在达到饱和时拦截请求并把它们暂存在内存队列中。这可以通过 `SaturationDetector` 插件配置（例如基于每个端点进行中请求计数的 Concurrency 插件）。
- 基于优先级的排队：它把流量划分到不同的“优先级档（Priority Band）”。实时的、对延迟敏感的任务（如聊天）优先于后台批处理任务（如摘要）。

- 资源公平性：它通过隔离各条流量来防止“吵闹邻居”问题，确保单个流（例如某个用户或应用）无法独占所有可用的推理槽位。公平性可通过两种可插拔策略配置：FairnessPolicy 管控同一优先级档内相互竞争的各个流之间的分发机会分配（例如轮询），OrderingPolicy 插件则定制流内请求的排序（例如 FIFO、基于 SLO）。

- 动态分发：它监控饱和度，只在模型服务器准备好处理时才向其发送请求。

设计的更多细节请参阅[流量控制](flow-control.md)。

#### 请求调度器（可扩展） {#request-scheduler-extensible}

调度器是智能请求路由的核心决策引擎。它通过由 ProfileHandler 插件编排的模块化“过滤 → 打分 → 选择”插件流水线运行，从而为每个请求评估并选出最合适的模型服务器端点。

通过在每个阶段使用自定义插件——过滤掉不可用的端点、根据“最小负载”或“亲和性”等指标为端点打分、选出最终候选——EPP 确保了推理资源池中的高性能和高效的资源分配。

设计的更多细节请参阅[请求调度](scheduling.md)。

#### 数据层（可扩展） {#data-layer-extensible}

**数据层**以异步方式运行，从多种来源消费并存储数据：

- 从 Kube API Server 获取 InferencePool 中哪些 Pod 处于活跃状态
- 从模型服务器获取当前的内部状态（运行中的请求、KV 缓存利用率）
- 内存数据结构，例如用于前缀感知路由的前缀缓存树
- 用于高级路由的“顾问”Sidecar，例如延迟预测器、KV 索引器或分词器

EPP 中的其他模块在处理请求时会查询**数据层**。

设计的更多细节请参阅[数据层](datalayer.md)。

## 如何配置 {#how-to-configure}

EPP 的配置方式是通过 `--config-file` 或 `--config-text` 命令行参数，把一份 `EndpointPickerConfig` YAML 传给二进制程序。该配置定义了管控请求处理、流量控制和调度的插件、特性开关和运行参数。

:::info
配置只在启动时读取。对配置的任何修改都需要重启 EPP 进程才能生效。
:::


关于配置结构、心智模型和示例的详细指南，请参阅[配置指南](configuration.md)。
