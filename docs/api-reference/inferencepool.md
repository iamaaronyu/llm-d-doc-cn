# InferencePool

`InferencePool` 是 `InferencePools` API 的结构定义。它定义了一组可供 Gateway 使用的推理端点。

**组：**`inference.networking.k8s.io`
**版本：**`v1`

---

## InferencePool {#inferencepool-1}

| 字段 | 说明 |
| --- | --- |
| `apiVersion` | `inference.networking.k8s.io/v1` |
| `kind` | `InferencePool` |
| `metadata` | [metav1.ObjectMeta](https://kubernetes.io/docs/reference/generated/kubernetes-api/v1.28/#objectmeta-v1-meta) |
| `spec` | [InferencePoolSpec](#inferencepoolspec) <br/> **必填** <br/> Spec 定义 InferencePool 的期望状态。 |
| `status` | [InferencePoolStatus](#inferencepoolstatus) <br/> Status 定义 InferencePool 的观测状态。 |

## InferencePoolSpec

`InferencePoolSpec` 定义 InferencePool 的期望状态。

| 字段 | 说明 |
| --- | --- |
| `selector` | [LabelSelector](#labelselector) <br/> **必填** <br/> Selector 决定哪些 Pod 是该推理资源池的成员。它只在同一命名空间内按标签匹配 Pod；不支持跨命名空间选择。<br/> 其结构刻意保持简单，以便与 Kubernetes Service 选择器兼容。 |
| `targetPorts` | [][Port](#port) <br/> **必填** <br/> TargetPorts 定义该 InferencePool 暴露的端口列表。EPP 会把每个端口视为一个独立的端点，以 `podIP:portNumber` 组合寻址。<br/> 最多 8 项。端口号必须唯一。 |
| `appProtocol` | [AppProtocol](#appprotocol) <br/> AppProtocol 描述所有目标端口的应用协议。未指定时默认为 `http`（HTTP/1.1）。 |
| `endpointPickerRef` | [EndpointPickerRef](#endpointpickerref) <br/> **必填** <br/> EndpointPickerRef 是对端点选择器扩展及其关联配置的引用。 |

## InferencePoolStatus

`InferencePoolStatus` 定义 InferencePool 的观测状态。

| 字段 | 说明 |
| --- | --- |
| `parents` | [][ParentStatus](#parentstatus) <br/> Parents 是与该 InferencePool 关联的父资源（通常是 Gateway）列表，以及 InferencePool 相对于每个父资源的状态。<br/> 最多 32 项。 |

## Port

`Port` 定义该 InferencePool 将要暴露的网络端口。

| 字段 | 说明 |
| --- | --- |
| `number` | `int32` <br/> **必填** <br/> Number 定义访问所选模型服务器 Pod 的端口号。必须在 1 到 65535 之间。 |

## AppProtocol

`AppProtocol` 描述端口的应用协议。

支持的取值：

- `http`：HTTP/1.1。这是默认值。
- `kubernetes.io/h2c`：明文 HTTP/2。通常用于在 Gateway 处终止 TLS 的 gRPC 工作负载。

## EndpointPickerRef

`EndpointPickerRef` 指定对端点选择器扩展及其关联配置的引用。

| 字段 | 说明 |
| --- | --- |
| `group` | `string` <br/> 被引用 API 对象所属的组。默认为 ""（核心 API 组）。 |
| `kind` | `string` <br/> 被引用对象的类型。默认为 `Service`。实现必须不（MUST NOT）支持 `ExternalName` 类型的 Service。 |
| `name` | `string` <br/> **必填** <br/> 被引用 API 对象的名称。 |
| `port` | [Port](#port) <br/> 端点选择器扩展服务的端口。当 `kind` 为 `Service` 时必填。 |
| `failureMode` | `string` <br/> 配置当端点选择器扩展无响应时，父资源如何处理。<br/> 默认为 `FailClose`。<br/> 支持的取值：`FailOpen`、`FailClose`。 |

## ParentStatus

`ParentStatus` 定义从某个父资源（即 Gateway）角度观测到的 InferencePool 状态。

| 字段 | 说明 |
| --- | --- |
| `conditions` | [][metav1.Condition](https://kubernetes.io/docs/reference/generated/kubernetes-api/v1.28/#condition-v1-meta) <br/> Conditions 提供关于观测状态的信息。支持的类型：`Accepted`、`ResolvedRefs`。 |
| `parentRef` | [ParentReference](#parentreference) <br/> **必填** <br/> 标识该状态所关联的父资源。 |
| `controllerName` | `string` <br/> 写入该状态的控制器名称（例如 `example.net/gateway-controller`）。 |

## ParentReference

`ParentReference` 标识一个 API 对象，例如 Gateway。

| 字段 | 说明 |
| --- | --- |
| `group` | `string` <br/> 被引用对象所属的组。默认为 `gateway.networking.k8s.io`。 |
| `kind` | `string` <br/> 被引用对象的类型。默认为 `Gateway`。 |
| `name` | `string` <br/> **必填** <br/> 被引用对象的名称。 |
| `namespace` | `string` <br/> 被引用对象的命名空间。默认为本地命名空间。 |

## LabelSelector

`LabelSelector` 定义基于标签查询资源的条件。

| 字段 | 说明 |
| --- | --- |
| `matchLabels` | `map[string]string` <br/> **必填** <br/> 一组 &#123;key,value&#125; 键值对。对象必须匹配该映射中的每一个标签（AND 关系）。<br/> 最多 64 个属性。 |

---

## 条件类型与原因 {#condition-types-and-reasons}

### Accepted

表示 `InferencePool` 是否已被某个父资源接受或拒绝。

- **为 True 时的原因：**
  - `Accepted`：父资源支持。
- **为 False 时的原因：**
  - `NotSupportedByParent`：父资源不支持把 InferencePool 作为后端。
  - `HTTPRouteNotAccepted`：被一个已被拒绝的 HTTPRoute 引用。
- **为 Unknown 时的原因：**
  - `Pending`

### ResolvedRefs

表示控制器是否成功解析了所有对象引用。

- **为 True 时的原因：**
  - `ResolvedRefs`
- **为 False 时的原因：**
  - `InvalidExtensionRef`：扩展无效（类型/组不受支持，或未找到）。

### Exported

表示控制器是否成功把 InferencePool 导出到指定的集群。

- **为 True 时的原因：**
  - `Exported`
- **为 False 时的原因：**
  - `NotRequested`：没有请求导出。
  - `NotSupported`：请求了导出，但实现不支持。
