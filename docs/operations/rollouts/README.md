# 发布

发布（Rollout）是一种渐进式的部署操作，以最小的服务中断逐步引入新版本的推理基础设施。发布不会一次性替换所有运行中的实例，而是逐步转移流量——让你能够在每个阶段监控行为，并在出现问题时立即回滚。

## 为什么发布对 LLM 推理很重要 {#why-rollouts-matter-for-llm-inference}

LLM 推理工作负载的一些特性使一次性全部替换尤其危险：

- **长时间运行的请求**：生成过程中的请求无法迁移。突然替换 Pod 会导致明显的失败。
- **预热成本**：新的模型服务器 Pod 需要时间加载模型权重、编译 CUDA graph 并填充 KV 缓存。在预热完成之前到达的流量会遭遇高延迟。
- **资源密集**：GPU 显存非常昂贵。回滚一个有问题的部署意味着要等待完整的冷启动周期。

渐进式发布能同时缓解这三个问题：在新版本接受真实流量验证期间，稳定版本始终保持完全可用。

## 发布策略 {#rollout-strategies}

### 滚动更新 {#rolling-update}

滚动更新（Rolling Update）是标准的 Kubernetes 部署策略，在单个 InferencePool 内逐步更新 Pod。这种方式在独立模式和 llm-d 路由器网关模式下都适用。

**工作方式：**

- 增量更新 Pod（例如每次 25%）
- 在新 Pod 健康之前，旧 Pod 持续处理流量
- Kubernetes Deployment 内置支持

**适用于：**

- 对流量比例没有严格要求的一般性、非关键更新
- 希望节省计算资源的场景
- 开发和预发环境

**了解更多：**[Kubernetes 滚动更新教程](https://kubernetes.io/docs/tutorials/kubernetes-basics/update/update-intro/)

### 蓝绿更新（HTTPRoute 流量拆分） {#blue-green-update-httproute-traffic-splitting}

蓝绿更新（Blue-Green Update）会创建第二个完整的 InferencePool，并使用 HTTPRoute 控制流量在旧版本（蓝）和新版本（绿）之间的分配。该策略需要 llm-d 路由器网关模式。

**工作方式：**

- 在现有 InferencePool 旁边部署一个完整的新 InferencePool
- 使用 HTTPRoute 逐步转移流量（例如 1% → 5% → 10% → 50% → 100%）
- 通过调整 HTTPRoute 权重即可立即回滚

**适用于：**

- 需要渐进式金丝雀发布的关键、高风险生产部署
- 需要快速回滚的场景
- 基于请求头的路由（例如把 beta 用户路由到新版本）
- 需要精确控制流量的更新

**指南：**[蓝绿更新](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/rollouts/blue-green-update.md)

### LoRA 适配器发布 {#lora-adapter-rollout}

LoRA（低秩适配）适配器发布让你可以在不改变基础模型或基础设施的情况下更新模型定制。这在独立模式和 llm-d 路由器网关模式下都适用。

**工作方式：**

- 使用 `InferenceModelRewrite` 把模型名称映射到特定的适配器版本
- 在不同适配器版本之间逐步转移流量
- 无需改动基础设施

**在以下情况下使用 LoRA 适配器发布：**

- 需要在不中断服务的情况下部署 LoRA 适配器的新版本
- 希望用一部分流量测试适配器的改动
- 需要同时维护多个适配器版本

**指南：**[LoRA 适配器发布](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/rollouts/adapter-rollout.md)

## 策略对比 {#strategy-comparison}

| 特性 | 滚动更新 | 蓝绿更新 |
|---------|---------------|-------------------|
| **路由控制** | 在所有健康 Pod 之间随机/均匀分配 | 精确的百分比（例如正好 1% 或 10%） |
| **影响范围** | 大（所有用户都可能随机接触到新版本） | 小（仅限指定的目标权重） |
| **回滚速度** | 慢（需要反向创建新 Pod） | 立即（把 HTTPRoute 权重改回 0） |
| **资源成本** | 低（只有临时多出的 Pod） | 高（需要同时运行两套完整环境） |
| **版本共存** | 在同一个 Service 内同时活跃 | 严格隔离在两个不同的 Service 中 |
| **部署模式** | 独立模式和网关模式 | 仅网关模式 |

LoRA 适配器发布没有基础设施成本，在两种模式下都适用，但只适用于变更仅限于适配器权重的情况——不适用于基础模型或服务框架的变更。

:::note
容量管理也可能影响在这些策略之间的选择。
:::
