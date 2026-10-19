# EPP HTTP 请求头参考

本文介绍[端点选择器（EPP）](../architecture/core/router/epp)会检查的 HTTP 请求头，它们用于管理和控制推理请求，具体涉及流量控制、性能管理和请求分类。

## 请求分类与流量控制 {#request-classification-and-flow-control}

这些请求头让 EPP 能够识别请求的目标、为公平的资源分配对请求进行分组，并处理针对特定模型的路由。

| 请求头 | 说明 |
| --- | --- |
| `x-llm-d-inference-objective` | 指定与请求关联的 `InferenceObjective` 资源名称。EPP 用它在**与 InferencePool 相同的命名空间**中查找对应的目标资源，以应用其中定义的优先级和性能目标。 |
| `x-llm-d-inference-fairness-id` | 提供一个唯一标识符，用于在基于公平性的流量控制中对请求分组。具有相同 ID 的请求按照公平性策略共享容量。省略时，EPP 默认使用 `default-flow`。 |
| `x-llm-d-model-name-rewrite` | 指定请求要使用的目标模型名称。这是模型名称改写的另一种方式；`InferenceModelRewrite` API 在服务端提供基于规则的改写，而这个请求头允许针对单个请求进行显式覆盖。存在该请求头时，EPP 会用它的值覆盖请求体中的模型名称，并用于记录与模型相关的指标。 |

## 服务等级目标（SLO） {#service-level-objectives-slos}

这些请求头被准入控制和负载均衡插件用来根据延迟目标做出决策。

| 请求头 | 说明 |
| --- | --- |
| `x-llm-d-slo-ttft-ms` | 指定目标首 token 时间（TTFT），单位为毫秒。插件据此判断在满足延迟目标的前提下能否准入该请求。 |
| `x-llm-d-slo-tpot-ms` | 指定目标每输出 token 时间（TPOT），单位为毫秒。用于基于预测或实测的 token 生成延迟进行准入控制。 |

## 已弃用的别名 {#deprecated-aliases}

llm-d 路由器 v0.9.0 及更新版本接受此前由 EPP 管理的请求头名称，作为已弃用的读取别名。新的集成和示例应使用规范的 `x-llm-d-*` 名称。更早的版本只认旧名称，因此混合版本的集群应在滚动升级期间协调请求头的迁移。可用版本请参阅 [llm-d 路由器发布页面](https://github.com/llm-d/llm-d-router/releases)。

如果一个请求同时发送了规范请求头及其已弃用的别名，规范的 `x-llm-d-*` 取值会确定性地胜出。目前尚未公布移除这些别名的版本或日期；请把别名视为临时的兼容性支持，所有新客户端都应优先使用规范名称。

| 已弃用的别名 | 规范请求头 |
| --- | --- |
| `x-gateway-inference-fairness-id` | `x-llm-d-inference-fairness-id` |
| `x-gateway-inference-objective` | `x-llm-d-inference-objective` |
| `x-gateway-model-name-rewrite` | `x-llm-d-model-name-rewrite` |
| `x-slo-ttft-ms` | `x-llm-d-slo-ttft-ms` |
| `x-slo-tpot-ms` | `x-llm-d-slo-tpot-ms` |

此次重命名只适用于由 llm-d/EPP 管理的用户请求头和控制请求头。[Gateway API Inference Extension（GAIE）端点选择协议](https://github.com/kubernetes-sigs/gateway-api-inference-extension/tree/main/docs/proposals/004-endpoint-picker-protocol)中的请求头，例如 `x-gateway-destination-endpoint*`，保持不变。

## 响应头 {#response-headers}

这些响应头由 EPP 设置在返回给客户端的响应上。

| 响应头 | 说明 |
| --- | --- |
| `x-llm-d-request-dropped-reason` | 表示请求被流量控制丢弃的原因。仅出现在由 EPP 生成（而非从模型服务器转发）的 `429` 响应上。其取值采用双前缀方案：`rejected-*` 表示请求从未到达推理服务器，`evicted-*` 表示请求已被分发、随后又被终止。可能的取值见下表。 |

### 丢弃原因取值 {#dropped-reason-values}

| 取值 | 含义 |
| --- | --- |
| `rejected-saturated` | 系统已达容量上限，请求在排队之前即被拒绝。 |
| `rejected-ttl-expired` | 请求已进入队列，但在分发之前其 TTL 已过期。 |
| `rejected-context-cancelled` | 请求排队期间客户端断开了连接。 |
| `evicted` | 通用的分发后驱逐。 |
| `evicted-queue-pressure` | 因新到达请求带来的背压而在分发后被驱逐。 |
| `evicted-priority` | 分发后被更高优先级的请求抢占而驱逐。 |

双前缀约定有助于调用方决定重试策略：`rejected-*` 表示没有进行任何推理工作（重试成本低），`evicted-*` 表示已经消耗了 GPU 周期（应纳入退避考量）。

---

## 实现说明 {#implementation-notes}

- **大小写：**所有请求头查找都不区分大小写。
- **来源：**这些取值通常以标准 HTTP 请求头的形式出现在传入请求中。
