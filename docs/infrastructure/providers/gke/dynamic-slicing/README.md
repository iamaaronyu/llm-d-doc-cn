# GKE 上的 TPU 动态切片

本文介绍在 GKE TPU7x 动态子切片上部署模型服务器时 llm-d 特有的配置。集群准备由 Google Cloud 提供文档，下文给出链接而不在此重复。它是成熟路径指南中各动态切片方案的基础设施前提：

* [TPU 子切片上的优化基线](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/optimized-baseline/modelserver/tpu/v7/vllm-dynamic-slice)
* [TPU 子切片上的 P/D 分离](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/pd-disaggregation#dynamic-sub-slices-tpu7x)

## 概述 {#overview}

[动态切片](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/dynamic-slicing)把 TPU 预配与切片分配解耦。Ironwood（TPU7x）容量以固定的 `4x4x4` 子块形式预配（16 个 `tpu7x-standard-4t` 节点，64 颗芯片），此时没有激活的芯片间互联（ICI），由 GKE 托管的切片控制器在调度时根据 `Slice` 自定义资源组建切片。**动态子切片**会把一个子块划分为相互独立的 `2x2x1`、`2x2x2`、`2x2x4` 或 `2x4x4` 切片，使形态不同的聚合式副本、prefill 工作节点和 decode 工作节点能够共享同一份预先预配的容量。

GKE 支持两种使用模式：由自定义调度器直接管理 `Slice` 资源；或者使用带拓扑感知调度（TAS）的 [Kueue](https://kueue.sigs.k8s.io/)，由 Kueue 准入检查自动创建和管理 `Slice` 资源。llm-d 的方案使用 **Kueue TAS** 路径。

## 前提条件 {#prerequisites}

请按照[在 GKE 中结合 Kueue 使用动态切片](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/use-gke-dynamic-slicing)准备集群：

1. [要求](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/use-gke-dynamic-slicing#requirements)：Rapid 渠道的 GKE Standard、TPU7x、All Capacity 模式的预留，以及子切片所需的 Kueue、JobSet 和 LeaderWorkerSet（LWS）最低版本。LWS 是必需的：llm-d 方案把每个模型服务器副本部署为一个 `LeaderWorkerSet` 组。
2. [启用切片控制器](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/use-gke-dynamic-slicing#enable_the_slice_controller)
3. [安装 Kueue、JobSet 和 LWS](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/use-gke-dynamic-slicing#install-components)
4. [使用增量预配创建节点池](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/use-gke-dynamic-slicing#create-tpu-node-pools)：先创建一个 `provision_only` 工作负载策略，再为每个预留子块创建一个 16 节点的节点池。
5. [安装 Kueue 切片控制器](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/use-gke-dynamic-slicing#install_kueue_slice_controller)
6. [验证节点和分区的状态](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/create-dynamic-slices#verify-nodes-partitions)：每个节点都应针对每种子切片形态带有 `cloud.google.com/gke-tpu-partition-<shape>-id` 和 `-state` 标签。

## 用于 llm-d 的 Kueue 资源 {#kueue-resources-for-llm-d}

GCP 指南中发布的 Kueue 资源面向的是超级切片（super-slicing）。子切片需要一个列举子块完整分区层级的 `Topology`：从 `cloud.google.com/gce-topology-block` 开始，经过每个 `cloud.google.com/gke-tpu-partition-<shape>-id` 标签，一直到 `kubernetes.io/hostname`。[`kueue-tas.yaml`](./kueue-tas.yaml) 提供了这个 `Topology`，同时还包括一个 `ResourceFlavor`、一个把切片组建委托给切片控制器（`accelerator.gke.io/slice`）的 `AdmissionCheck`，以及一个覆盖 `google.com/tpu`、`cpu` 和 `memory` 的 `ClusterQueue`。每个集群应用一次即可：

```bash
kubectl apply -f kueue-tas.yaml
```

然后在每个运行动态切片模型服务器的命名空间中创建 [`LocalQueue`](./kueue-localqueue.yaml)，例如针对 P/D 分离指南：

```bash
kubectl apply -n llm-d-pd-disaggregation -f kueue-localqueue.yaml
```

## 工作负载要求 {#workload-requirements}

llm-d 的动态切片方案会在每个模型服务器 Pod 上设置以下内容；这里列出来，供需要改造自己清单的用户参考：

| 字段 | 取值 |
| --- | --- |
| 工作负载标签 | `kueue.x-k8s.io/queue-name: <LocalQueue name>` |
| Pod 注解 | `cloud.google.com/gke-tpu-slice-topology: "<shape>"`（例如 `2x2x2`） |
| Pod nodeSelector | `cloud.google.com/gke-tpu-accelerator: tpu7x` |
| Pod nodeSelector（健康状态） | `cloud.google.com/gke-tpu-partition-<shape>-state: "HEALTHY"`（参见[分区健康选择](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/use-gke-dynamic-slicing#define_the_partition_health_selection)） |
| 容忍 | 键 `google.com/tpu`，效果 `NoSchedule` |
| 资源 | 每个 Pod `google.com/tpu: 4`（requests 和 limits） |

**不要**设置传统 TPU 节点池所用的静态 `cloud.google.com/gke-tpu-topology` nodeSelector；切片放置由 Kueue 和切片控制器决定。

每个 `tpu7x-standard-4t` 节点有 4 颗芯片，每颗 TPU7x 芯片有 2 个核心，因此形态 `AxBxC` 对应每个切片 `(A*B*C)/4` 个 Pod，并支持最大为 `A*B*C*2` 的 `--tensor-parallel-size`：

| 形态 | 芯片数 | 每切片 Pod 数（LWS `size`） | 核心数（最大 TP） |
| --- | --- | --- | --- |
| `2x2x1` | 4 | 1 | 8 |
| `2x2x2` | 8 | 2 | 16 |
| `2x2x4` | 16 | 4 | 32 |
| `2x4x4` | 32 | 8 | 64 |

切片名称最长 49 个字符，且 Kueue 会根据命名空间、工作负载名称和副本索引来生成名称，因此请让命名空间和 `LeaderWorkerSet` 的名称保持简短。

## 运维 {#operations}

可以通过 `kubectl get slices -A` 查看切片状态（`ACTIVATING`、`ACTIVE`、`FAILED`、`INCOMPLETE`）；状态细节和 Cloud Monitoring 指标请参阅[监控切片](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/use-gke-dynamic-slicing#monitor-dynamic-slicing)。拆除环境时，请先删除 `LeaderWorkerSet` 资源，以便 Kueue 删除它所创建的 `Slice` 资源；处于活跃状态的切片会阻止节点池被删除。参见[清理](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/use-gke-dynamic-slicing#clean-up)。
