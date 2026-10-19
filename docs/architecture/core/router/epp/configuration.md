# 配置

`EndpointPickerConfig` 是端点选择器（EPP）的核心配置，定义了驱动请求处理、流量控制和调度决策的插件图及参数。

配置文本的形式如下：

```yaml
apiVersion: llm-d.ai/v1alpha1
kind: EndpointPickerConfig
plugins:
- ....
- ....
featureGates:
  ...
requestHandler:
  ...
flowControl:
  ...
schedulingProfiles:
- ....
- ....
dataLayer:
  ...
```

:::info
虽然配置语法看起来像 Kubernetes 自定义资源，但它**不是** Kubernetes CRD。配置不会被控制器调谐，只在启动时读取。更新配置需要重启 EPP。
:::


- **元数据**：配置的前两行是常量（`apiVersion` 和 `kind`），必须原样出现。
- **插件（Plugins）**：定义将被实例化的插件集合及其参数。
- **特性开关（Feature Gates）**：启用或禁用特定的实验性或可选功能（例如流量控制）。
- **请求处理（Request Handling）**：管理请求在调度阶段前后的完整生命周期，涵盖协议解析、通过数据生产者准备状态以及最终的准入决策。
- **流量控制（Flow Control）**：通过在网关处对请求排队来保障优先级和公平性，同时评估资源池饱和度以防止过载，从而实现资源池防护和多租户管理（通过 `flowControl` 字段配置，包括其嵌套的 `saturationDetector`）。
- **调度（Scheduling）**：定义用于为每个请求选择最优模型服务器候选的 Profile 和插件（遵循“过滤 -> 打分 -> 选择”生命周期）。
- **数据层（Data Layer）**：配置用于智能调度决策和可观测性的后端数据来源和指标采集。

## 配置心智模型：插件与连线 {#configuration-mental-model-plugins-and-wiring}

`EndpointPickerConfig` 构成一张配置**图**，在三个层面定义 EPP 的运行方式：

- **插件（节点）**：在 `plugins` 部分，实例化具体的实现（例如自定义打分器或公平性策略）并提供其参数。
- **连线（边）**：在 `schedulingProfiles` 或 `flowControl` 等结构性部分，按名称把这些插件关联到特定的架构角色（例如告诉某个 Profile 使用特定的打分器）。
- **静态运行时配置**：除了这张图之外，扁平的配置参数（例如 `maxBytes` 或 `defaultRequestTTL`）为运行时设定静态的运行限制和默认值。

这种设计使你可以只定义一次插件，然后在多个 Profile 或优先级档中复用，而不必重复其参数。

:::note
**自动连线**：部分子系统支持自动绑定。如果某个插件声明在顶层 `plugins` 列表中，并实现了特定的 Go 接口（例如 `Admitter`、`DataProducer`，或 `PreRequest`、`ResponseHeaderProcessor`、`ResponseBodyProcessor` 等高级钩子），系统会自动发现它并将其绑定到相应角色，无需在结构性配置中显式连线。
:::


为确保这张图的完整性，以下**校验规则**适用于所有层面：

- **有效引用**：任何引用插件的字段（例如 `schedulingProfiles` 中的 `pluginRef` 或 `flowControl.saturationDetector`）都必须引用顶层 `plugins` 部分中定义的有效名称。
- **名称唯一**：所有需要命名的列表（例如 `schedulingProfiles`）中的每个实例都必须具有唯一且非空的名称。
- **数据依赖**：系统会校验指标提取器构成一个没有循环依赖的有向无环图（DAG），以保证正确的执行顺序。

## 使用 `EndpointPickerConfig` {#using-the-endpointpickerconfig}

使用 `--config-file` 命令行参数指定配置文件的路径。例如：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${EPP_NAME}
  ...
spec:
  ...
  template:
    ...
    spec:
      ...
      containers:
      - name: epp
        args:
        - --pool-name
        - "${POOL_NAME}"
        ...
        - --config-file
        - "/etc/epp/epp-config.yaml" # 通常从 ConfigMap 挂载
```

如果以内联文本的形式传入配置，请使用 `--config-text` 命令行参数。例如：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${EPP_NAME}
  ...
spec:
  ...
  template:
    ...
    spec:
      ...
      containers:
      - name: epp
        args:
        - --pool-name
        - "${POOL_NAME}"
        ...
        - --config-text
        - |
          apiVersion: llm-d.ai/v1alpha1
          kind: EndpointPickerConfig
          plugins:
          - type: prefix-cache-scorer
          - type: approx-prefix-cache-producer
            parameters:
              blockSizeTokens: 5
              maxPrefixTokensToMatch: 1280
              lruCapacityPerServer: 31250
          schedulingProfiles:
          - name: default
            plugins:
            - pluginRef: prefix-cache-scorer
              weight: 1 # 默认值
```

## 配置指南 {#configuration-guide}

### `plugins`

此部分声明要实例化的插件集合及其参数。

每个插件还可以指定一个名称，这样在需要时（例如配置多个调度 Profile 时）同一类型的插件就可以被实例化多次。此部分中的每个条目形式如下：

```yaml
- name: aName
  type: a-type
  parameters:
    param1: val1
    param2: val2
```

插件条目中的字段：

- `name`：可选，为插件实例提供一个可供引用的名称。如果省略该字段，则以插件类型作为其名称。
- `type`：指定要实例化的插件类型。
- `parameters`：可选，定义用于配置该插件的参数集合。具体参数因插件而异。

### `featureGates`

`featureGates` 部分用于启用 EPP 中的可选或实验性功能。列在这里的功能会被激活；未列出的功能保持禁用。

```yaml
featureGates:
- flowControl
```

**支持的特性开关：**

- `flowControl`：启用准入与流量控制层。要使用 `flowControl` 配置部分，必须启用此开关。

#### 移除特性开关 {#removing-a-feature-gate}

为确保向后兼容，通常应在两个版本中逐步移除特性开关：

1. **第一个版本：**将该功能标记为稳定并默认启用，但在配置中保留该特性开关，作为已弃用但仍可用的开关，使现有配置保持有效，并让运维人员在需要时可以通过禁用该功能临时回滚。在此阶段，应告知用户（例如通过发布说明）该特性开关已弃用，并将在下一版本中移除。
2. **第二个版本：**从配置和代码中彻底移除该特性开关。

### 请求处理 {#request-handling}

此部分涵盖在请求到达调度阶段之前、或在选定后端之后，处理请求和响应的组件。

> 完整的架构细节以及可用解析器、准入器和数据生产者的列表，请参阅[请求处理参考](request-handling.md)。

#### 解析器 {#parsers}

`requestHandler.parsers` 部分配置 EPP 如何理解协议消息（例如 OpenAI 或 vLLM 载荷）。默认情况下，当未指定 `requestHandler.parsers` 时，EPP 会配置三个内置解析器：`openai-parser`、`anthropic-parser` 和 `vllmhttp-parser`，它们会被自动实例化，无需 `plugins` 条目。请求由第一个声明能处理其路径的已配置解析器处理（例如 `/v1/chat/completions` 由 `openai-parser` 处理，`/v1/messages` 由 `anthropic-parser` 处理，`/inference/v1/generate` 由 `vllmhttp-parser` 处理）。

设置 `parsers` 会替换这个默认列表。要使用非默认解析器，必须先在 `plugins` 部分实例化它，然后在 `parsers` 列表的条目中引用其名称：

```yaml
plugins:
- name: myParser
  type: vllmgrpc-parser
# ...
requestHandler:
  parsers:
  - pluginRef: myParser
```

#### 准入器与数据生产者 {#admitters--data-producers}

准入器和数据生产者是在请求初始处理阶段执行的专门插件：

- **准入器**在请求进入队列之前进行早期检查，决定接受还是拒绝。
- **数据生产者**为每个请求收集下游组件所需的上下文信息（例如预测延迟或前缀缓存状态）。

如[心智模型](#configuration-mental-model-plugins-and-wiring)中所述，这些插件支持基于接口的自动绑定，从而减少原本需要显式连线的样板配置。

如果在顶层 `plugins` 列表中声明了准入器或数据生产者插件，系统会在启动时根据其能力自动识别，并把它绑定到相应的生命周期钩子：

- **准入器**：如果实现了用于提前准入或拒绝请求的 Go 接口，就会被自动绑定。
- **数据生产者**：如果实现了用于收集其他组件所需的每请求数据（例如延迟预测）的 Go 接口，就会被自动绑定。

要启用这些插件，只需把它们列在 `plugins` 部分：

```yaml
plugins:
- name: latency-admitter
  type: latency-slo-admitter
  parameters: ...
# 添加计算预测延迟的数据生产者。预测延迟由 latency-slo-admitter 使用。
- name: latency-producer
  type: predicted-latency-producer
  parameters: ...
```

它们会自动生效，无需在配置的其他地方引用。

---

### 流量控制 {#flow-control}

关于 EPP 流量控制层内部工作原理的更多架构细节，请参阅[流量控制](flow-control.md)。

`flowControl` 部分配置 EPP 的流量控制层。该层在请求到达后端模型服务器之前对其进行缓冲，起到资源池防护的作用。流量控制实现了三层分发层级：**优先级 → 公平性 → 排序**。实际效果的图示请参阅[流量控制参考中的排队拓扑图](flow-control.md#queuing-topology--the-3-tier-dispatch)。

启用流量控制（通过 `FlowControl` 特性开关）后，传入请求会在内存中排队，并按照配置的优先级档、公平性策略和排序策略进行分发。当资源池饱和时（由[饱和检测器](#saturation-detector)判定），请求会留在队列中，直到有容量释放。

下面的示例展示了一个启用流量控制的完整 `EndpointPickerConfig`，演示如何配置 `featureGates`、`plugins` 和 `flowControl` 部分（包括嵌套的 `saturationDetector`）使其协同工作。

```yaml
apiVersion: llm-d.ai/v1alpha1
kind: EndpointPickerConfig

featureGates:
- flowControl

plugins:
- type: round-robin-fairness-policy
- type: fcfs-ordering-policy
- type: global-strict-fairness-policy
- type: utilization-detector
# ... 其他插件 ...

flowControl:
  maxBytes: 0 # 默认：不限制
  maxRequests: 0 # 默认：不限制
  defaultRequestTTL: "0s" # 默认：使用客户端上下文的截止时间
  enableEviction: false # 默认：禁用进行中请求驱逐

  saturationDetector:
    pluginRef: utilization-detector # 默认值

  defaultPriorityBand:
    maxBytes: "1Gi" # 默认值
    maxRequests: 0 # 默认：不限制
    orderingPolicyRef: fcfs-ordering-policy # 默认值
    fairnessPolicyRef: global-strict-fairness-policy # 默认值

  priorityBands: # 只展示覆盖项；未指定的字段继承默认值
  - priority: 100
    maxBytes: "5Gi"
    maxRequests: 500
    fairnessPolicyRef: round-robin-fairness-policy

  - priority: 50
    maxBytes: "2Gi"
    maxRequests: 200

# ... 其他部分（schedulingProfiles、dataLayer 等）...
```

#### 全局字段 {#global-fields}

- `maxBytes`：跨所有优先级的全局容量上限。支持 Kubernetes 资源数量格式（例如 `10Gi`、`512Mi`）或普通整数（字节）。如果为 `0` 或省略，则不施加全局限制（不限制）。
- `maxRequests`：可选的全局最大请求数上限。如果为 `0` 或省略，则不施加全局限制（不限制）。
- `defaultRequestTTL`：未携带截止时间的请求的兜底超时。如果为 `0` 或省略，则默认使用客户端上下文的截止时间（可能会无限等待）。
- `enableEviction`：为 `true` 时，当更高优先级的请求因资源池饱和而受阻，已分发的**负优先级**（`priority < 0`）请求可以被驱逐以回收容量。节奏和规模会根据所选的饱和检测器自动配置。默认禁用。生命周期和响应映射请参阅[进行中请求驱逐](flow-control.md#in-flight-eviction)。
- `defaultPriorityBand`：一个模板，用于动态创建未在 `priorityBands` 中显式配置的优先级档。
- `priorityBands`：针对特定优先级的显式配置列表。

#### 优先级档字段 {#priority-band-fields}

这些字段同时适用于 `defaultPriorityBand` 和 `priorityBands` 中的条目：

- `priority`：（`priorityBands` 条目必填）整数优先级；值越大优先级越高。
- `maxBytes`：该档的总字节上限。默认：`1Gi`。
- `maxRequests`：该档的并发请求上限。默认：不设每档上限。
- `orderingPolicyRef`：引用用于该档内请求排序的插件名称。默认：`fcfs-ordering-policy`。
- `fairnessPolicyRef`：引用用于该档内公平性策略的插件名称。默认：`global-strict-fairness-policy`。

可用的公平性策略和排序策略的完整列表，请参阅[流量控制参考](flow-control.md#concrete-plugins)。

#### 饱和检测器 {#saturation-detector}

`saturationDetector` 部分配置用于评估后端 InferencePool 是否过载的机制。它嵌套在 `flowControl` 之下，形式如下：

```yaml
flowControl:
  saturationDetector:
    pluginRef: utilization-detector # 默认值
```

##### 字段 {#fields}

- `pluginRef`：引用全局 `plugins` 部分中定义的插件实例。省略或为空时默认为 `utilization-detector`。*注意：如果 `plugins` 数组中没有显式定义 `utilization-detector`，网关会在内部使用标准默认参数自动实例化一个。*

可用的饱和检测器插件的完整列表，请参阅[流量控制参考](flow-control.md#concrete-plugins)。

---

### 调度 Profile {#scheduling-profiles}

`schedulingProfiles` 部分配置 EPP 的调度组件。完整的架构细节以及可用过滤器、打分器和选择器的列表，请参阅[调度参考](scheduling.md)。

传入请求通过执行这些 Profile 中定义的过滤器、打分器和最终选择器组成的流水线，被路由到候选模型服务器。

下面的示例演示了如何配置一个调度 Profile，所用的具体数值是典型生产环境的推荐值：

```yaml
schedulingProfiles:
- name: default
  plugins:
  - pluginRef: label-selector-filter # 可选：不在默认 Profile 中
  - pluginRef: prefix-cache-scorer # 推荐：不在默认 Profile 中
    weight: 3.0
  - pluginRef: kv-cache-utilization-scorer # 推荐：不在默认 Profile 中
    weight: 2.0
  - pluginRef: queue-scorer # 推荐：不在默认 Profile 中
    weight: 2.0
  - pluginRef: max-score-picker # 默认选择器（省略时自动注入）
```

:::note
要使用**精确**前缀缓存路由（基于 KV 事件的精确方式）代替默认的近似方式，请在顶层 `plugins` 部分声明一个 `precise-prefix-cache-producer`，并在 `prefix-cache-scorer` 上设置 `prefixMatchInfoProducerName: precise-prefix-cache-producer`；否则打分器会回退到近似生产者。请参阅[精确前缀缓存路由指南](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/precise-prefix-cache-routing)。
:::


#### 调度 Profile 字段 {#scheduling-profile-fields}

- `name`：调度 Profile 的唯一名称。
- `plugins`：构成该 Profile 调度流水线的插件列表。

#### Profile 插件字段 {#profile-plugin-fields}

- `pluginRef`：按名称（如果省略了名称则按类型）引用顶层 `plugins` 部分中定义的插件。
- `weight`：可选的浮点权重，在被引用的插件是打分器时生效。如果打分器省略该字段，默认为 `1.0`。

:::danger
如果你在顶层 `plugins` 部分定义了多个选择器，同时省略了 `schedulingProfiles`，自动生成的 `default` Profile 会引用**所有**选择器，从而在初始化时报错（见下文“多个选择器”）。
:::


<details>
<summary>默认行为</summary>

系统对调度 Profile 采用多层默认逻辑：

- **第 1 层：省略 `schedulingProfiles`**：如果完全省略 `schedulingProfiles` 部分，会自动创建一个名为 `default` 的 Profile。该 Profile 会引用顶层 `plugins` 部分中定义的**所有过滤器、打分器和选择器插件**。
- **第 2 层：Profile 中 `plugins` 为空**：如果定义了 Profile 但 `plugins` 列表为空，它是有效的，但只会得到自动注入的选择器（见第 3 层）。
- **第 3 层：Profile 中缺少选择器**：如果 Profile 没有引用任何选择器插件，系统会自动注入 `max-score-picker`，并使用其默认值 `maxNumOfEndpoints: 1`。要使用不同的值或选择器，请显式声明并在 Profile 中引用。

</details>

#### Profile 执行规则 {#profile-execution-rules}

虽然 YAML 配置在 Profile 中呈现的是扁平的插件列表，但框架会按特定规则处理它们：

- **接口角色**：框架在内部根据被引用插件实现的接口，将其归类为不同角色（过滤器、打分器或选择器）。
- **执行顺序**：插件按以下顺序执行：先过滤器，再打分器，最后是选择器。
- **多个选择器**：一个调度 Profile **不能**有多个选择器。在 Profile 的 `plugins` 列表中引用多个选择器，会在 Profile 初始化时导致运行时错误。
- **打分器权重**：如果打分器省略了 `weight` 字段，默认为 `1.0`。多个打分器的分数在乘以各自权重后累加。

#### Profile 处理器与使用场景 {#profile-handlers-and-use-cases}

- **多个 Profile**：对于简单的服务场景，一个 Profile 就足够了；但像**分离式 prefill** 这样的高级场景，需要两个或更多 Profile 以区别处理不同类型的请求。
- **Profile 处理器**：定义了多个 Profile 时，必须在顶层 `plugins` 部分实例化并配置一个 **Profile 处理器**插件。Profile 处理器决定每个传入请求使用哪个 `SchedulingProfile`。
- **单 Profile 默认值**：如果只定义了一个 Profile，系统会隐式使用 `SingleProfileHandler` 把所有请求路由到该 Profile，因此无需显式配置处理器。

对于像 `prefix-cache-scorer` 这样常用的插件，需要在顶层 `plugins` 部分配置它，并在 Profile 中引用：

```yaml
plugins:
- type: prefix-cache-scorer
# 向前缀缓存打分器传参时，还需添加 approx-prefix-cache-producer（数据生产者）。
- type: approx-prefix-cache-producer
  parameters:
    blockSizeTokens: 64
    maxPrefixTokensToMatch: 16384 # 256 块 * 64 token/块
    lruCapacityPerServer: 31250 # 默认值

# ...

schedulingProfiles:
- name: default
  plugins:
  - pluginRef: prefix-cache-scorer
    weight: 3.0
```

<details>
<summary><b>高级示例：多个 Profile 与 Profile 处理器</b></summary>

对于需要多个 Profile 的高级场景，必须在顶层 `plugins` 列表中配置自定义的 Profile 处理器。系统会检查哪个插件实现了 `ProfileHandler` 接口，从而自动识别它。

```yaml
plugins:
- name: my-custom-profile-handler
  type: custom-profile-handler # 必须实现 framework.ProfileHandler
  parameters:
    # ... 处理器特定的配置 ...
- name: filter-a
  type: some-filter
- name: filter-b
  type: another-filter
- name: scorer-1
  type: some-scorer

schedulingProfiles:
- name: profile-a
  plugins:
  - pluginRef: filter-a
  - pluginRef: scorer-1
- name: profile-b
  plugins:
  - pluginRef: filter-b
  - pluginRef: scorer-1
```

**重要：**配置中只允许有一个 Profile 处理器插件。如果定义了多个 Profile，必须提供支持多 Profile 的处理器（默认的 `single-profile-handler` 不支持多个 Profile）。

</details>

### `dataLayer`

`dataLayer` 部分配置用于智能调度决策和可观测性的后端数据来源和指标采集。它定义一组数据来源，以及从中拉取数据的提取器。

> 完整细节以及可用数据来源和提取器的列表，请参阅[数据层参考](datalayer.md)。

```yaml
dataLayer:
  sources:
  - pluginRef: metrics-data-source # 引用 'plugins' 部分中的插件
    extractors:
    - pluginRef: core-metrics-extractor # 引用 'plugins' 部分中的插件
```

#### 字段 {#fields-1}

- `sources`：需要轮询或监视的数据来源列表。
  - `pluginRef`：引用全局 `plugins` 部分中定义的、实现了 `DataSource` 接口的插件实例。
  - `extractors`：与该数据来源关联的提取器列表。
    - `pluginRef`：引用全局 `plugins` 部分中定义的、实现了 `Extractor` 接口的插件实例。

:::note
`metrics-data-source` 和 `core-metrics-extractor` 会被**默认注入**，因此即使完全不配置 `dataLayer`，标准的指标采集也能正常工作。注入是叠加式的——即使你提供了自己的 `dataLayer`，默认的指标来源也会追加到你的来源之后。除非你设置了 `injectDefaults: false`，或者 `dataLayer.sources` 中已经包含了 `metrics-data-source` 来源。
:::


## 高可用 {#high-availability}

要以高可用（HA）的主备（active-passive）方式部署 EndpointPicker，请把 `replicas` 设为大于 1。在这种配置下，任一时刻只有一个“leader”副本处于活跃状态并处理流量。如果 leader Pod 故障，另一个 Pod 会被选举为新的 leader，从而保证服务连续性。

要启用高可用，请确保 EPP Deployment 的副本数大于 1。

## 监控 {#monitoring}

EPP 在 **9090 端口**的 `/metrics` 路径暴露兼容 Prometheus 的指标端点。这些指标提供请求处理、调度决策、流量控制行为以及后端资源池健康状况的可见性。

> 完整的上游文档请参阅 [Gateway API Inference Extension 指标与可观测性指南](https://gateway-api-inference-extension.sigs.k8s.io/guides/metrics-and-observability/)。

### 按子系统划分的 EPP 指标 {#epp-metrics-by-subsystem}

指标按负责相应逻辑的子系统组织。各子系统可用指标的详细表格，请参阅：

- **[请求处理指标](request-handling.md#metrics--observability)**：请求量、延迟、token 用量和成功率。
- **[流量控制指标](flow-control.md#metrics--observability)**：队列大小、分发周期和资源池饱和度。
- **[路由指标](scheduling.md#metrics--observability)**：路由器性能和资源池健康状态。

### 监控技术栈 {#monitoring-stack}

推荐的监控技术栈是 **Prometheus + Grafana**。上游仓库在 [`tools/dashboards/inference_gateway.json`](https://github.com/kubernetes-sigs/gateway-api-inference-extension/blob/main/tools/dashboards/inference_gateway.json) 提供了预置的 Grafana 仪表盘。

上游还提供了预配置的告警规则，涵盖：

- **P99 延迟过高**——当 P99 请求延迟超过 10 秒时触发
- **错误率过高**——当错误率超过 5% 时触发
- **队列过长**——当模型服务器队列深度超过 50 个请求时触发
- **KV 缓存利用率过高**——当 KV 缓存利用率超过 90% 时触发
