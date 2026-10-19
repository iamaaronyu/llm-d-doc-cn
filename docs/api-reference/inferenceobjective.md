# InferenceObjective

`InferenceObjective` 表示某个特定模型使用场景的期望状态。它让“推理工作负载所有者”能够为 `InferencePool` 内的模型定义性能和延迟目标。

**组：**`llm-d.ai`
**版本：**`v1alpha2`

---

## InferenceObjective {#inferenceobjective-1}

| 字段 | 说明 |
| --- | --- |
| `apiVersion` | `llm-d.ai/v1alpha2` |
| `kind` | `InferenceObjective` |
| `metadata` | [metav1.ObjectMeta](https://kubernetes.io/docs/reference/generated/kubernetes-api/v1.28/#objectmeta-v1-meta) |
| `spec` | [InferenceObjectiveSpec](#inferenceobjectivespec) <br/> Spec 表示该模型使用场景的期望状态。 |
| `status` | [InferenceObjectiveStatus](#inferenceobjectivestatus) <br/> Status 定义 InferenceObjective 的观测状态。 |

## InferenceObjectiveSpec

`InferenceObjectiveSpec` 定义该模型工作负载的优先级以及对资源池的引用。

| 字段 | 说明 |
| --- | --- |
| `priority` | `int` <br/> **可选** <br/> 定义与同一资源池中的其他请求相比，处理该请求的重要程度。值越大优先级越高。未设置时视为 `0`。资源紧张时，优先级更高的请求会被优先处理。 |
| `poolRef` | [PoolObjectReference](#poolobjectreference) <br/> **必填** <br/> 对推理资源池的引用。该资源池必须位于同一命名空间中。 |

## InferenceObjectiveStatus

`InferenceObjectiveStatus` 定义 InferenceObjective 的观测状态。

| 字段 | 说明 |
| --- | --- |
| `conditions` | [][metav1.Condition](https://kubernetes.io/docs/reference/generated/kubernetes-api/v1.28/#condition-v1-meta) <br/> Conditions 跟踪 InferenceObjective 的状态。已知类型：`Accepted`。 |

## PoolObjectReference

`PoolObjectReference` 标识同一命名空间内的一个 API 对象。

| 字段 | 说明 |
| --- | --- |
| `group` | `string` <br/> 被引用对象所属的组。默认为 `inference.networking.k8s.io`。 |
| `kind` | `string` <br/> 被引用对象的类型。默认为 `InferencePool`。 |
| `name` | `string` <br/> **必填** <br/> 被引用对象的名称。 |

---

## 条件类型与原因 {#condition-types-and-reasons}

### Accepted

表示该目标配置是否已被接受。

- **为 True 时的原因：**
  - `Accepted`：模型与资源池的状态一致。
- **为 Unknown 时的原因：**
  - `Pending`：初始状态，控制器尚未调谐该资源。
