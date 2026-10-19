# 路由器运维指南

本指南介绍 llm-d 路由器各组件的运维最佳实践、高可用部署架构以及容器规格建议。

---

## 1. 端点选择器运维 {#1-endpoint-picker-operations}

无论以**独立模式**还是**网关模式**部署端点选择器（EPP），资源分配和多副本扩缩行为都取决于预期的查询吞吐量、前缀缓存匹配的复杂度以及高可用（HA）要求。

### 高可用与扩缩模式 {#high-availability--scaling-modes}

运行多个端点选择器副本（`router.epp.replicas > 1`）时，其行为取决于所配置的 HA 模式。

#### 主备模式（默认） {#active-passive-mode-default}

默认情况下，多副本 EPP 部署会自动启用 `--ha-enable-leader-election` 参数。一个 leader 副本主动提供路由决策并协调租约状态，其余副本作为热备。

- **对规模与容量的影响**：增加副本数并不会提升总的请求吞吐容量，因为只有唯一处于活跃状态的 leader 副本处理外部处理请求。
- **Fail Open**：EPP 被配置为在 leader 选举或 Pod 重启期间对模型服务器 fail open（`router.proxy.failOpen=true`）。这确保了即使 EPP 无响应或不可用，客户端请求也不会被丢弃，而是继续由模型服务器处理。

```yaml
router:
  proxy:
    failOpen: true
```

#### 双活模式 {#active-active-mode}

要让所有 EPP 副本同时分担路由吞吐，请在 `router.epp.flags` 下传入 `ha-enable-leader-election: false` 以禁用 leader 选举：

```yaml
router:
  epp:
    replicas: 3
    flags:
      ha-enable-leader-election: false
```

- **接近线性的吞吐扩展**：多个 EPP 副本同时分担传入的请求负载：

  | 副本数 | 扩展倍数 |
  | :--- | :--- |
  | 1 | 1.0x |
  | 2 | 2.0x |
  | 3 | 2.7x |
  | 4 | 3.5x |

- **警告（插件与前缀兼容性）**：在双活模式下，只能使用兼容双活的插件——具体是那些动态查询后端模型服务器以获取实时指标和状态的插件（例如队列深度或 KV 缓存利用率打分器）。在双活模式下请避免使用近似前缀缓存插件；由于各副本不共享本地内存状态，前缀路由会在副本之间被分割，导致缓存命中率显著下降。

### 容器资源规划 {#container-resource-sizing}

#### CPU 分配 {#cpu-allocation}

- **经验法则**：对于大型智能体工作负载（约 10 万输入 / 1 千输出 token），按预期吞吐量每 1 请求/秒分配 **0.5 到 1.0 个 CPU 核心**。
- **前缀匹配开销**：增大 `maxPrefixTokensToMatch` 会增加 CPU 消耗。在较低吞吐下，由于块搜索开销，较大的前缀上限（例如 100,000 个 token / 6,250 个块，`blockSizeTokens: 16`）相比较小的上限（4,096 个 token / 256 个块），CPU 消耗可能增加 100% 以上。
- **空闲抓取开销**：由于后台的 Prometheus 抓取，空闲时的 CPU 消耗随模型服务 Pod 总数增长。在有 100 个 Pod 的集群中，EPP 空闲消耗约达 **7.5 个核心**。

#### 内存分配 {#memory-allocation}

- **进行中并发**：内存占用与并发的进行中请求数以及输出 decode 长度直接相关。
- **规划建议**：
  - 在 50 到 100 请求/秒、1 千输出 token 的情况下，EPP 需要 **4 到 6 GiB** 内存。
  - 对于长输出生成（例如 5 千以上输出 token），由于并发请求状态的累积，内存占用可能超过 **20 GiB**。

### 性能参考数据 {#performance-reference-data}

在 100 个服务 Pod 上模拟 Qwen/Qwen3-8B 的实测基准参考数据：

#### 吞吐量与前缀块规模（10 万输入 / 1 千输出 token） {#throughput-and-prefix-block-sizing-100k-input--1k-output-tokens}

| 配置 | 请求速率（请求/秒） | maxPrefixTokensToMatch | 峰值 CPU（核） | 峰值内存（GiB） | 调度器 P50 延迟（秒） |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 小前缀匹配 | 5.0 | 4096 | 1.19 | 0.26 | 0.00010 |
| 大前缀匹配 | 5.0 | 100000 | 3.82 | 0.65 | 0.00010 |
| 小前缀匹配 | 98.7 | 4096 | 35.17 | 2.46 | 0.00014 |
| 大前缀匹配 | 98.8 | 100000 | 46.50 | 3.41 | 0.00020 |

#### 输出长度变化（恒定吞吐 50 请求/秒） {#output-length-variation-50-reqs-constant-throughput}

| 输入 token | 输出 token | maxPrefixTokensToMatch | 峰值 CPU（核） | 峰值内存（GiB） |
| :--- | :--- | :--- | :--- | :--- |
| 100k | 500 | 4096 | 15.13 | 2.27 |
| 100k | 500 | 32768 | 17.14 | 3.76 |
| 100k | 1000 | 4096 | 17.51 | 3.66 |
| 100k | 1000 | 32768 | 20.28 | 5.23 |
| 100k | 5000 | 16384 | 30.95 | 12.54 |
| 100k | 10000 | 8192 | 32.53 | 12.54 |

---

## 2. 独立模式下的代理运维 {#2-proxy-operations-in-standalone-mode}

以下运维指南和代理扩展架构**仅适用于独立模式**（`llm-d-router-standalone`），在该模式下由代理（Envoy 或 Agentgateway）拦截客户端请求，并通过 EPP 进行外部处理。

### 可水平扩展的代理服务（Service 模式） {#horizontally-scalable-proxy-service-service-mode}

默认情况下，独立 Chart 把代理作为 Sidecar 容器部署在 EPP Pod 内。要让数据面吞吐独立于控制面智能进行扩展，请设置 `router.proxy.mode=service`，把代理部署为单独的、可水平扩展的 Deployment 和 Service。

在这种解耦的架构中，代理通过集群内的 EPP Service 与 EPP 通信。如果 EPP 发生主备 leader 故障切换或短暂的 Pod 重启，代理默认会 fail open（`router.proxy.failOpen=true`），从而保证客户端请求的处理不中断。

```bash
helm install my-standalone-router ./config/charts/llm-d-router-standalone \
  --set router.modelServers.matchLabels.app=my-vllm-service \
  --set router.inferencePool.create=false \
  --set router.proxy.mode=service \
  --set router.proxy.replicas=3
```

#### 基于 Fail-open 的高可用 {#high-availability-with-fail-open}

在 Service 模式下，默认启用 fail open。如需禁用，请设置 `router.proxy.failOpen=false`。

下面是在 2 个模型服务器副本上模拟 Qwen/Qwen2.5-1.5B-Instruct、并强制或优雅终止 Leader EPP Pod 的实测基准参考数据。在不同的 Envoy 代理副本数下，`router.proxy.failOpen=true` 都能在 leader Pod 拆除期间保持很高的请求可用性。残余错误发生在 Pod 终止那一刻的 socket 拆除过程中。

| 场景 | Envoy 副本数 | EPP 副本数 | 请求总数 | 成功请求数（吞吐） | 错误数 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **场景 1**<br>有备用 Pod 的 leader 选举，Pod 立即终止、未优雅关闭 | 1 | 2 | 598 | 598（100%） | 0 |
| | 2 | 2 | 591 | 584（98.8%） | 7 |
| **场景 2**<br>无备用 Pod 的 leader 选举，Pod 立即终止、未优雅关闭 | 1 | 1 | 598 | 588（98.3%） | 1 |
| | 2 | 1 | 592 | 589（99.3%） | 4 |
| **场景 3**<br>有备用 Pod 的 leader 选举，Pod 优雅终止 | 1 | 2 | 593 | 591（99.7%） | 2 |
| | 2 | 2 | 594 | 583（98.1%） | 11 |
| **场景 4**<br>无备用 Pod 的 leader 选举，Pod 优雅终止 | 1 | 1 | 591 | 591（100%） | 0 |
| | 2 | 1 | 593 | 589（99.3%） | 4 |

### 代理容器资源规划 {#proxy-container-resource-sizing}

以 Envoy 作为独立代理运行时，CPU 消耗随客户端请求速率线性增长，而内存消耗在各种工作负载下都保持稳定。

#### CPU 与内存建议 {#cpu--memory-guidelines}

- **CPU 分配**：低于 10 请求/秒时，**1.2 到 2.0 个核心**即可。对于 100 请求/秒、10 万上下文长度，至少分配 **8 个核心**（实测峰值 7.27 个核心）。对于较小上下文长度下的高并发（1 万上下文、892 请求/秒），至少分配 **10 个核心**。
- **内存占用**：在所有测试的吞吐量和上下文长度下，Envoy 的内存占用稳定在 **1.3 到 1.4 GiB** 之间。基线分配 **2 GiB**。

#### Envoy 性能参考数据 {#envoy-performance-reference-data}

| 输入 token | 输出 token | 吞吐量（请求/秒） | 峰值 CPU（核） | 峰值内存（GiB） |
| :--- | :--- | :--- | :--- | :--- |
| 100k | 1k | 10.0 | 1.20 | 1.30 |
| 100k | 1k | 100.0 | 7.27 | < 1.40 |
| 10k | 1k | 892.0 | 8.78 | 1.40 |

### Helm 资源覆盖示例 {#helm-resource-override-example}

下面的 `resource_overrides.yaml` 示例为 EPP 和独立 Envoy 代理容器配置资源，可支撑 10 万/1 千 token 工作负载下的 50 请求/秒：

```yaml
router:
  epp:
    resources:
      requests:
        cpu: "32"
        memory: "64Gi"
      limits:
        memory: "128Gi"

  proxy:
    resources:
      requests:
        cpu: "8"
        memory: "2Gi"
      limits:
        memory: "4Gi"
```

```bash
helm install optimize-baseline ./config/charts/llm-d-router-standalone -f resource_overrides.yaml
```
