# InferenceModelRewrite

`InferenceModelRewrite` 定义改写推理请求的规则，例如在多个加权模型目标之间进行流量拆分、A/B 测试或金丝雀发布。

**组：**`llm-d.ai`
**版本：**`v1alpha2`

---

## InferenceModelRewrite {#inferencemodelrewrite-1}

| 字段 | 说明 |
| --- | --- |
| `apiVersion` | `llm-d.ai/v1alpha2` |
| `kind` | `InferenceModelRewrite` |
| `metadata` | [metav1.ObjectMeta](https://kubernetes.io/docs/reference/generated/kubernetes-api/v1.28/#objectmeta-v1-meta) |
| `spec` | [InferenceModelRewriteSpec](#inferencemodelrewritespec) <br/> Spec 定义改写规则的期望状态。 |
| `status` | [InferenceModelRewriteStatus](#inferencemodelrewritestatus) <br/> Status 定义该资源的观测状态。 |

## InferenceModelRewriteSpec

| 字段 | 说明 |
| --- | --- |
| `poolRef` | [PoolObjectReference](#poolobjectreference) <br/> **必填** <br/> 对目标 `InferencePool` 的引用。 |
| `rules` | [][InferenceModelRewriteRule](#inferencemodelrewriterule) <br/> **必填** <br/> 有序的规则集合。使用第一条与请求匹配的规则。 |

## InferenceModelRewriteRule

`InferenceModelRewriteRule` 定义匹配条件及相应的动作（目标）。

| 字段 | 说明 |
| --- | --- |
| `matches` | [][Match](#match) <br/> **可选** <br/> 匹配请求的条件。指定多个条件时为逻辑或（OR）关系。为空时匹配所有请求。 |
| `targets` | [][TargetModel](#targetmodel) <br/> **可选** <br/> 如何在多个加权模型目标之间分配流量。最少 1 项。 |

## Match

`Match` 定义匹配 LLM 请求的条件。

| 字段 | 说明 |
| --- | --- |
| `model` | [ModelMatch](#modelmatch) <br/> **必填** <br/> 匹配 JSON 请求体中 `model` 字段的条件。 |

## ModelMatch

| 字段 | 说明 |
| --- | --- |
| `type` | `string` <br/> 使用的字符串匹配方式。支持的取值：`Exact`。默认为 `Exact`。 |
| `value` | `string` <br/> **必填** <br/> 用于匹配的模型名称字符串。 |

## TargetModel

`TargetModel` 定义一个加权的模型目标。

| 字段 | 说明 |
| --- | --- |
| `weight` | `int32` <br/> **可选** <br/> 转发到该模型的请求比例，按 `weight/(所有权重之和)` 计算。最小 1，最大 1000000。如果为某一项设置了权重，则必须为所有项都设置。 |
| `modelRewrite` | `string` <br/> **必填** <br/> 把请求改写成的静态模型名称。 |

## InferenceModelRewriteStatus

| 字段 | 说明 |
| --- | --- |
| `conditions` | [][metav1.Condition](https://kubernetes.io/docs/reference/generated/kubernetes-api/v1.28/#condition-v1-meta) <br/> Conditions 跟踪状态。已知类型：`Accepted`。 |

## PoolObjectReference

`PoolObjectReference` 标识同一命名空间内的一个 API 对象。

| 字段 | 说明 |
| --- | --- |
| `group` | `string` <br/> 被引用对象所属的组。默认为 `inference.networking.k8s.io`。 |
| `kind` | `string` <br/> 被引用对象的类型。默认为 `InferencePool`。 |
| `name` | `string` <br/> **必填** <br/> 被引用对象的名称。 |

---

## 优先级与冲突解决 {#precedence-and-conflict-resolution}

1. **模型匹配精度：**带有 `Exact` 模型匹配的规则优先于通用匹配（`matches` 为空）。
2. **资源存在时长：**如果多个资源以完全相同的匹配条件指向同一个资源池，则最早创建的资源（按创建时间戳）优先。
3. **规则顺序：**在单个资源内部，使用（按列表顺序）第一条匹配的规则。

---

## 条件类型与原因 {#condition-types-and-reasons}

### Accepted

表示该改写是否有效、无冲突，并已应用到资源池。

- **为 True 时的原因：**
  - `Accepted`：改写有效且已成功应用。
- **为 Unknown 时的原因：**
  - `Pending`：初始状态，控制器尚未调谐该资源。
