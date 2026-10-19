# 基于 KEDA 的 SLO 感知自动扩缩容——控制律

本文完整推导了 [SLO 感知自动扩缩容指南](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/workload-autoscaling/slo-aware)所使用的控制律：EPP 的延迟直方图如何变成单一的饱和度信号，KEDA 公式如何把该信号映射为期望副本数，以及设计中每处不对称的原因。可部署的清单、可调参数和基准测试结果请使用该指南；当你想理解或修改这个控制回路本身时，请阅读本文。

这是 [KEDA + EPP 设计](./keda-epp.md)的一个特化版本：流水线相同，同样由 KEDA 管理 HPA，只是以延迟而不是队列深度作为信号。

共五个步骤，持续评估。第 1–2 步是你要部署的部分（记录规则 + 公式）；第 3–4 步是塑造响应过程的标准 HPA/Kubernetes 机制；第 5 步解释了它为什么会收敛。

## 1. 信号链（记录规则，每 15 秒） {#1-signal-chain-recording-rules-every-15-s}

饱和度信号是资源池的 P90 延迟相对于 SLO 的比值——取两个目标中较差的那个：

```math
s_{raw} = \max\!\left(\frac{\text{P90 TTFT}}{S_{ttft}},\ \frac{\text{P90 TPOT}}{S_{tpot}}\right), \qquad \text{NaN/no traffic} \mapsto 0
```

每个 P90 都是基于 1 分钟桶速率计算的 `histogram_quantile(0.9, ...)`，优先使用预测直方图，回退到实际直方图（`>= 0` 过滤器会丢弃存在但已失效的预测序列，其分位数为 NaN）。`s_raw < 1` 表示尾延迟在 SLO 之内；`> 1` 表示违反 SLO；空闲资源池读数为 0。

然后进行截断和平滑：

```math
s = \text{avg\_over\_time}\big(\min(s_{raw},\ C)\big)[45s], \qquad C = 2.0
```

不要省略截断：在排队“拐点”处，预测延迟可能在单个样本中飙升到 SLO 的 10–90 倍。任何高于上限的值本来就意味着“以最大速率增加容量”——放任原始数值通过只会污染移动平均，使其在资源池恢复后很长时间仍然偏高。

## 2. 期望副本数（KEDA 公式） {#2-desired-replicas-the-keda-formula}

设 `s` = 平滑后的饱和度，`n` = 已预配的副本数，`r` = 就绪副本数，阈值 `θ_up = 0.55`、`θ_dn = 0.40`（在 ScaledObject 中，它们分别对应 `saturation`、`replicas` 和 `readyReplicas` 触发器）：

```math
d = \begin{cases} n + \left\lceil n \left( \frac{s \cdot c}{\theta_{up}} - 1 \right) \right\rceil & s > \theta_{up} \quad\text{(scale up, credited)} \\ n - \left\lfloor n \left( 1 - \frac{s}{\theta_{dn}} \right) \right\rfloor & s < \theta_{dn} \quad\text{(scale down, uncredited)} \\ n & \text{otherwise} \quad\text{(hysteresis band)} \end{cases}
```

其中**在途抵扣（in-flight credit）**`c = r/n`（当 `0 < r < n` 时，否则为 1）只在扩容分支上应用。这里有三处刻意的不对称，每一处都有其价值：

- **迟滞区间（0.40–0.55）：**资源池在两个边界之间保持稳定，而不是围绕单一设定点来回抖动。
- **抵扣：**信号只在就绪的 Pod 上测量。扩容进行中时，就绪的 Pod 会高估预热完成后的负载；用 `r/n` 折减需求，可以让扩容请求只覆盖已在预热的 Pod 之外的缺口，而不是每个周期都冲向 `maxReplicas`。
- **缩容使用未抵扣的信号：**抵扣会折减需求，因此在预热期间，它可能把一个超过阈值的信号压到缩容边界以下，导致在扩容过程中缩减副本。只有当实测信号本身确有余量时，资源池才可以缩容。

**为什么阈值设得较低：**在健康负载下，基于预测延迟 P90 的信号大约位于 SLO 的 0.2–0.45 之间，然后在排队拐点处*陡然上升*。阈值接近 1.0 时，只有在 SLO 预算几乎耗尽后才会触发；0.55 则在拐点前的上升阶段就会触发。如果你的 SLO 接近基础延迟，请提高这个区间。

在 ScaledObject 中，`d` 是 `scalingModifiers` 公式的输出，组合目标值为 `1`（AverageValue）——即直接透传：公式输出*就是*期望副本数。

## 3. HPA 层（限速与稳定） {#3-hpa-layer-rate-limiting-and-stabilization}

KEDA 生成的 HPA 会把 `d` 限制在 `[minReplicaCount, maxReplicaCount]` 范围内，并应用 `behavior` 配置块：扩容每 60 秒最多突增 `max(100 %, 4 个 Pod)`，稳定窗口 30 秒（取窗口内最小值）；缩容每 120 秒减少 1 个 Pod，窗口 180 秒（取窗口内最大值）。快速扩容，审慎缩容。

## 4. 就绪副本（Pod 预热） {#4-ready-replicas-pod-warmup}

新增副本需要经过预热时间 $`T_w`$ 才能就绪（模型加载 + torch-compile）；移除则是即时的：

```math
R(t) = \min_{\tau \in [t - T_w,\ t]} N_{spec}(\tau)
```

$`T_w`$ 正是第 2 步中引入抵扣的原因，也是最值得优化的调节项：Pod 预热大约占扩容过渡过程的*一半*，缩短它就能直接减少每次扩容时付出的违约代价。通过 torch-compile 缓存卷 + 快速的 startupProbe，我们把 Pod 就绪时间从约 2 分 15 秒缩短到约 100 秒；该补丁随指南提供，即 [`slo-aware/decode-warmup-patch.yaml`](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/workload-autoscaling/slo-aware/decode-warmup-patch.yaml)（推荐——将其应用到 decode Deployment，参见指南的部署一节）。指南中的基准测试结果就是使用这个补丁得出的。

## 5. 闭合回路 {#5-closing-the-loop}

就绪副本更多 → 每个 Pod 的负载更低 → 预测的 P90 下降 → `s` 重新进入区间，扩容请求停止。预配不足会推高 `s`，回路随之增加容量；预配过多会使 `s` 降到 0.40 以下，缓慢的缩减开始。系统会稳定在 `s` 落入区间内的位置——在这些 SLO 下，对于 prefill 长度为 4000 token 的工作负载，经验值约为每个 H100 TP=2 副本 1.4–1.5 rps。
