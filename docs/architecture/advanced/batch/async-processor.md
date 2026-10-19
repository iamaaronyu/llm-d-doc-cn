# 异步处理器架构

异步处理器是一个轻量级分发代理，它从消息队列中拉取推理请求并转发给 llm-d 路由器。它使用分发门控、相互隔离的工作池、请求体转换和合并策略来调节分发速率，在不压垮推理服务器的前提下高效处理后台工作负载。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)">
    <img src="/img/versioned/0.10/assets/async-processor.svg" alt="异步处理器高层架构">
  </picture>
</p>

## 内部流水线架构 {#internal-pipeline-architecture}

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)">
    <img src="/img/versioned/0.10/assets/async-processor-internal.svg" alt="llm-d-async 内部流水线架构（4 个队列和 2 个工作池）">
  </picture>
</p>

## 工作原理 {#how-it-works}

1. **队列门控与轮询**——在从队列中拉取消息之前，请求会经过队列级的**分发门控**，根据系统指标和容量调节消息流和摄入量。
2. **合并**——从多个输入队列或主题订阅中轮询到的消息，按目标工作池分组，并根据全局配置的**请求合并策略**合并到每个池的合并通道中。
3. **工作池准入门控**——合并后的请求经过**工作池准入门控**（例如本地最大并发、池级饱和度或预算门控），确认工作池是否有容量和预算接受新工作。
4. **转换**——被准入的请求经过**请求体转换**，以规范化载荷结构，或注入路由请求头和参数。
5. **分发**——指定**工作池**中的并发工作线程把 HTTP 请求分发给 llm-d 路由器，并传递截止时间。
6. **结果**——成功时，结果被写回结果队列。遇到可重试的失败（限流、临时错误）时，请求会以指数退避方式重新入队。

## 分发门控 {#dispatch-gates}

分发门控通过控制从消息队列轮询请求时的消息摄入速率，以及工作池准入和下游分发速率，来调节请求流。门控在消息被拉取并准入工作流水线之前评估指标，从而防止下游推理服务器过载，维持系统稳定。

门控可以在两个不同层级上配置：

- **队列/订阅级**：在消息被轮询和合并之前控制流量和摄入。
- **工作池准入级**：控制进入工作池执行流水线。可以使用**组合门控**为一个池组合多个门控。

| 门控类型 | 行为 |
| --- | --- |
| `constant` | 始终开启——不限流。 |
| `redis` | 从 Redis 键中读取预算值，允许外部编排器动态调整每个队列或池的速率限制。 |
| `prometheus-saturation` | 向 Prometheus 查询模型服务器饱和度指标（例如 KV 缓存压力、队列深度）。当饱和度低于可配置阈值时允许摄入和准入。 |
| `prometheus-budget` | 直接根据指标计算可用的下游容量。 |
| `local-max-concurrency` | 限制工作池内的本地并发，以限定进行中请求数。 |

## 工作池与请求合并策略 {#worker-pools--request-merge-policies}

### 工作池 {#worker-pools}

异步处理器使用基于**工作池**的多租户流水线模型。

:::note
`llm-d-async` 的工作池**不是**推理资源池（例如下游的模型服务器池）。它是 `llm-d-async` 内部的分发流水线结构，用于配置**池名称**、**工作线程数**和**准入门控**。工作池配置完全由用户自定义。
:::


- **可配置的流水线**：定义池名称、并发工作线程数和准入门控设置。
- **组合门控**：可以使用**组合门控**为单个池配置多个门控（例如本地最大并发与 Prometheus 饱和度组合）。
- **后端隔离**：建议为不同的 `llm-d-router` 端点使用不同的工作池，这样某个后端模型服务器的饱和或背压不会阻塞其他端点的处理。
- **隔离**：已饱和或被阻塞的工作池不会影响其他工作池的处理或吞吐量。
- **队列到池的映射**：多个队列配置可以把请求路由到同一个工作池，但一个队列配置只能路由到一个工作池。

### 请求合并策略 {#request-merge-policies}

**请求合并策略**在流水线层面为整个 `llm-d-async` 实例全局配置一个（而不是按池配置）。`llm-d-async` 不在各个池上配置不同的策略类型，而是按分配的 `worker_pool_id` 对输入队列通道分组，并在每个池的合并通道上独立执行全局合并策略。

支持的两种全局合并策略：

| 策略 | 说明 |
| --- | --- |
| `random-robin` | 默认策略。从为每个池配置的所有队列中随机挑选消息。 |
| `tier-priority` | 使用路由标签（`(classification, tier)`）把请求放入 6 个严格优先级通道。在每个通道内，在不同的客户端通道之间轮询，并标记通道目标（`x-llm-d-inference-objective`）。 |

由于合并通道按工作池分组并独立评估，某个池合并通道上的背压只会影响其关联的工作池，从而保持多租户隔离。

## 请求体转换 {#request-body-transforms}

请求体转换插件根据每条消息的元数据，负责改写传出的请求体和 `Content-Type`。当没有插件适用时，默认的 JSON 路径会逐字节保持原样。

## 请求消息与结果消息 {#request-and-result-messages}

异步处理器为发布到输入队列的请求，以及返回到结果队列/主题的结果，定义了标准化的 JSON 结构。所有工作池都把完成的推理结果推送到为该 `llm-d-async` 处理器实例配置的单一、统一的**结果消息队列**（或主题）。

### 请求消息结构 {#request-message-schema}

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `string` | 用于结果映射的唯一标识符（必填）。 |
| `created` | `int64` | 创建时间戳（Unix 秒）。 |
| `deadline` | `int64` | 截止时间（Unix 秒，必填，必须为正数）。 |
| `payload` | `object` | 推理请求载荷。 |
| `metadata` | `map[string]string` | 可选的调用方透传数据（例如追踪 ID、用户标签）。 |
| `endpoint` | `string` | 可选的每请求分发路径；设置后会覆盖队列级默认值。 |

**请求消息示例：**

```json
{
  "id": "19933123533434",
  "created": 1764044000,
  "deadline": 1764045130,
  "payload": {
    "model": "food-review",
    "prompt": "hi",
    "max_tokens": 10,
    "temperature": 0
  },
  "metadata": {
    "user": "batch-job-42"
  }
}
```

### 结果消息结构 {#result-message-schema}

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `string` | 与对应请求映射的唯一标识符。 |
| `payload` | `bytes` / `object` | 下游模型服务器返回的推理结果载荷。 |
| `status_code` | `int` | HTTP 响应状态码（非零值表示收到了 HTTP 响应）。 |
| `error_code` | `string` | 错误分类码（例如 `DEADLINE_EXCEEDED`、`GATE_DROPPED`、`GATE_ERROR`、`INFERENCE_ERROR`、`INVALID_REQUEST`）。 |
| `error_message` | `string` | 人类可读的错误说明。 |

**结果消息示例：**

*成功结果：*

```json
{
  "id": "19933123533434",
  "payload": {
    "choices": [
      {
        "text": "Great food!"
      }
    ]
  },
  "status_code": 200
}
```

*错误结果：*

```json
{
  "id": "19933123533434",
  "error_code": "GATE_DROPPED",
  "error_message": "Pool gating dropped request"
}
```

## 消息队列集成 {#message-queue-integrations}

队列配置定义输入消息队列的来源参数（如 Redis 键或 Pub/Sub 订阅 ID），并为分发的请求指定目标 **`llm-d-router` 端点信息**（如 URL 路径和目标模型端点）。

| 实现 | 特点 |
| --- | --- |
| Redis Sorted Set | 持久化，按截止时间进行优先级排序。支持按队列配置门控。 |
| Redis Pub/Sub（**已弃用**——优先使用 Redis Sorted Set） | 非持久，扇出投递。目前仍可用，计划在未来版本中移除。 |
| GCP Pub/Sub | 云原生，可扩展。支持按订阅配置门控。 |

## 配置 {#configuration}

异步处理器通过针对消息队列来源和工作池的高层结构定义进行配置。

### 消息队列配置 {#message-queue-configurations}

队列配置指定输入消息队列参数、目标 `llm-d 路由器`端点、路由标签以及可选的队列级分发门控。

| 字段 | 类型 | 必填 | 说明 | 示例值 |
| --- | --- | --- | --- | --- |
| `queue_name` / `subscriber_id` | String | 是 | 输入队列名称或 Pub/Sub 订阅者 ID。 | `"batch_queue"` |
| `worker_pool_id` | String | 是 | 从该队列轮询到的消息要路由到的目标工作池 ID。 | `"worker_pool_1"` |
| `igw_base_url` | String | 是 | 目标 `llm-d 路由器`端点的基础 URL。 | `"http://localhost:80/"` |
| `request_path_url` | String | 是 | 目标路由器上的请求端点路径。 | `"/v1/completions"` |
| `inference_objective` | String | 可选 | 用于推理分类的路由标签。 | `"batch-task"` |
| `labels` | Object | 可选 | 用于消息元数据和路由标签的键值对。 | `{"tier": "standard"}` |
| `gate_type` | String | 可选 | 队列级分发门控的类型（例如 `redis`、`constant`）。 | `"redis"` |
| `gate_params` | Object | 可选 | 配置队列分发门控的键值参数。 | `{"address": "localhost:6379", "budget_key": "my-budget-key"}` |

**队列配置示例：**

```json
{
  "queue_name": "batch_queue",
  "inference_objective": "batch-task",
  "request_path_url": "/v1/completions",
  "igw_base_url": "http://localhost:80/",
  "worker_pool_id": "worker_pool_1",
  "gate_type": "redis",
  "gate_params": {
    "address": "localhost:6379",
    "budget_key": "my-budget-key"
  }
}
```

### 工作池配置 {#worker-pools-configuration}

工作池配置为相互隔离的执行流水线定义专用的工作线程并发上限和池准入门控。

| 字段 | 类型 | 必填 | 说明 | 示例值 |
| --- | --- | --- | --- | --- |
| `id` | String | 是 | 唯一的池标识符，由队列/主题配置引用（`worker_pool_id`）。 | `"worker-pool_1"` |
| `workers` | Integer | 是 | 该池专用的并发工作线程数。必须为正数。 | `32` |
| `gate_type` | String | 可选 | 应用于该池的分发门控类型（例如 `local-max-concurrency`、`prometheus-saturation`）。 | `"prometheus-saturation"` |
| `gate_params` | Object | 可选 | 配置池准入门控的键值参数。 | `{"pool": "inference_pool_1", "threshold": "0.8"}` |

**工作池配置示例：**

```json
[
  {
    "id": "worker-pool_1",
    "workers": 32,
    "gate_type": "prometheus-saturation",
    "gate_params": {
      "pool": "inference_pool_1",
      "threshold": "0.8"
    }
  }
]
```

更详细的配置选项请参阅 [llm-d-async README](https://github.com/llm-d/llm-d-async/blob/v0.10.0/README.md)。

## 并发与重试 {#concurrency-and-retries}

- **可配置的并行度**：各工作池定义各自独立的并发上限（默认每池 64），用于并行处理。
- **截止时间强制执行**：每个请求都携带来自队列消息的截止时间。工作线程会放弃无法在截止时间前完成的请求。
- **指数退避**：可重试的失败会以退避方式重新入队（基数 2 秒，最大 60 秒，带抖动）。致命错误（错误的载荷、不可恢复的失败）不会重试。

## 可观测性 {#observability}

Prometheus 指标包括请求总数、成功/失败计数、重试计数、超过截止时间的计数、被削减的请求计数、门控决策、分发预算以及请求延迟直方图。

## 相关内容 {#related}

- [异步处理器成熟路径](../../../well-lit-paths/workloads/batch-serving/asynchronous-processing.md)——部署异步处理器的指南。
- [异步处理器仓库](https://github.com/llm-d/llm-d-async)——源代码和 Helm Chart。
- [批处理网关](batch-gateway.md)——与异步处理器组合使用，实现批处理作业管理。
