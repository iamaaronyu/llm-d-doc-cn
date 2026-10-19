# EndpointPickerConfig（EPP 配置）

`EndpointPickerConfig` 定义**端点选择器（EPP）**的内部配置。与 Kubernetes 资源（如 `InferencePool`）不同，它是用于初始化 EPP 二进制程序的配置结构，通常通过 ConfigMap 或本地文件提供。

**组：**`llm-d.ai`
**版本：**`v1alpha1`

---

## EndpointPickerConfig

| 字段 | 说明 |
| --- | --- |
| `featureGates` | `[]string` <br/> 用于启用实验性功能的一组开关（例如 `flowControl`）。 |
| `plugins` | [][PluginSpec](#pluginspec) <br/> **必填** <br/> 要实例化的插件列表（例如打分器、适配器、上报器）。 |
| `schedulingProfiles` | [][SchedulingProfile](#schedulingprofile) <br/> **必填** <br/> 把插件分组到各路由槽位的具名 Profile。 |
| `dataLayer` | [DataLayerConfig](#datalayerconfig) <br/> 配置用于元数据提取和处理的数据层。 |
| `flowControl` | [FlowControlConfig](#flowcontrolconfig) <br/> 配置全局及按优先级的准入控制。仅在启用 `flowControl` 特性开关时生效。 |
| `requestHandler` | [RequestHandlerConfig](#requesthandlerconfig) <br/> 指定 EPP 处理传入请求所用的处理逻辑。 |

## PluginSpec

定义一个插件实例及其参数。

| 字段 | 说明 |
| --- | --- |
| `name` | `string` <br/> 该插件实例的唯一名称。省略时使用 `type`。 |
| `type` | `string` <br/> **必填** <br/> 要实例化的插件类型（例如 `least-request`、`openai-parser`）。 |
| `parameters` | `json.RawMessage` <br/> 传给插件工厂函数的任意参数。 |

## SchedulingProfile

把插件分组以定义特定的路由行为。

| 字段 | 说明 |
| --- | --- |
| `name` | `string` <br/> **必填** <br/> Profile 的名称。 |
| `plugins` | [][SchedulingPlugin](#schedulingplugin) <br/> **必填** <br/> 与该 Profile 关联的插件列表。 |

## SchedulingPlugin

| 字段 | 说明 |
| --- | --- |
| `pluginRef` | `string` <br/> **必填** <br/> 对顶层 `plugins` 列表中某个具名插件的引用。 |
| `weight` | `float64` <br/> 当该插件是打分器时使用的权重。 |

## FlowControlConfig

配置准入控制和排队。

| 字段 | 说明 |
| --- | --- |
| `maxBytes` | `resource.Quantity` <br/> 所有活跃请求的全局最大总字节数。 |
| `maxRequests` | `resource.Quantity` <br/> 全局最大并发请求数。 |
| `defaultRequestTTL` | `duration` <br/> 排队请求的兜底超时。 |
| `defaultPriorityBand` | [PriorityBandConfig](#prioritybandconfig) <br/> 未显式配置的优先级所使用的模板。 |
| `priorityBands` | [][PriorityBandConfig](#prioritybandconfig) <br/> 针对特定优先级的显式策略。 |
| `usageLimitPolicyPluginRef` | `string` <br/> 对用于自适应容量管理的 `UsageLimitPolicy` 插件的引用。 |
| `saturationDetector` | [SaturationDetectorConfig](#saturationdetectorconfig) <br/> 指定使用哪个饱和检测器插件。默认为 `utilization-detector`。 |

## PriorityBandConfig

| 字段 | 说明 |
| --- | --- |
| `priority` | `int` <br/> 整数优先级。值越大越关键。 |
| `maxBytes` | `resource.Quantity` <br/> 该优先级档允许的最大字节数。 |
| `maxRequests` | `resource.Quantity` <br/> 该档允许的最大并发请求数。 |
| `fairnessPolicyRef` | `string` <br/> 管控流选择的策略（默认：`global-strict-fairness-policy`）。 |
| `orderingPolicyRef` | `string` <br/> 管控流内请求选择的策略（默认：`fcfs-ordering-policy`）。 |

## RequestHandlerConfig

配置请求处理行为。

| 字段 | 说明 |
| --- | --- |
| `parsers` | [][ParserConfig](#parserconfig) <br/> 用于处理协议消息的解析插件列表。未指定时默认配置 `openai-parser`、`anthropic-parser` 和 `vllmhttp-parser`。 |

## DataLayerConfig

| 字段 | 说明 |
| --- | --- |
| `sources` | [][DataLayerSource](#datalayersource) <br/> **必填** <br/> 元数据来源列表。 |

## DataLayerSource

| 字段 | 说明 |
| --- | --- |
| `pluginRef` | `string` <br/> **必填** <br/> 对提供该数据来源的插件的引用。 |
| `extractors` | [][DataLayerExtractor](#datalayerextractor) <br/> **必填** <br/> 从该来源中提取特定属性的插件。 |

## SaturationDetectorConfig

| 字段 | 说明 |
| --- | --- |
| `pluginRef` | `string` <br/> 对用于饱和检测的插件实例的引用。 |

## ParserConfig

| 字段 | 说明 |
| --- | --- |
| `pluginRef` | `string` <br/> **必填** <br/> 对解析器插件实例的引用。 |
