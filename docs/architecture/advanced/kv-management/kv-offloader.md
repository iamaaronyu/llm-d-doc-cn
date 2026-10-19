# KV 缓存卸载

KV 缓存卸载把 KV 块迁移到 CPU DRAM 和共享存储等成本更低的层级，从而把有效缓存容量扩展到 GPU HBM 之外。

llm-d 可以与任何兼容 vLLM 或 SGLang 的 KV 缓存连接器配合使用。支持两种集成模式：

- **原生（vLLM `OffloadingConnector`）**——vLLM 内置的卸载路径。直接以 CPU 内存为目标，并通过 [llm-d FS 后端](https://github.com/llm-d/llm-d-kv-cache)以共享文件系统为目标。
- **树外连接器**——第三方缓存引擎（例如 [LMCache](https://lmcache.ai)、[Mooncake](https://github.com/kvcache-ai/Mooncake)、[NVIDIA KVBM](https://docs.nvidia.com/dynamo/latest/kvbm/)），它们通过模型服务器的 KV 缓存连接器 API 接入，并自行负责索引、内存管理和存储。

:::note
与 **llm-d 路由器**的缓存感知路由配合使用——路由器（具体是 **EPP**）选择能够复用已缓存块的副本；卸载则扩大了每个副本能容纳的缓存量。
:::


## 功能 {#functionality}

Transformer 推理在 prefill 阶段计算 Key 和 Value 张量，然后在 decode 阶段复用它们。对于长上下文或重复的前缀（系统提示词、智能体循环、多轮对话），重新计算这些张量会浪费大量 GPU 周期。KV 缓存卸载解决了两个扩展性限制：

1. **容量**——GPU HBM 有限（每块 GPU 几十 GB）。CPU 内存能再增加一个数量级，而存储几乎可以无限扩展。

2. **共享**——本地缓存在每个模型服务器实例之间是隔离的。共享存储支持跨节点的缓存复用、新副本的更快扩容，以及跨 Pod 重启的持久化。

卸载系统通常以异步方式运行。写入低层级在后台进行，不阻塞推理。从存储读取仍需要等待，但加载已缓存的块通常比重新计算更快——对于长提示词最多可快 16 倍。

## 架构 {#architecture}

两种集成模式对应两种不同的架构。

### 原生（vLLM OffloadingConnector） {#native-vllm-offloadingconnector}

原生路径完全位于 vLLM 技术栈内部。`OffloadingConnector` 把块分发到 CPU 层或共享存储层：

```
┌─────────────────────────────────────────────────────────────────┐
│                            vLLM                                 │
├─────────────────────────────────────────────────────────────────┤
│                      V1 Connector API                           │
├─────────────────────────────────────────────────────────────────┤
│                    Offloading Connector                         │
│        ┌───────────┐   ┌───────────┐   ┌───────────┐            │
│        │ Scheduler │   │  Worker   │   │  Metrics  │            │
│        └───────────┘   └───────────┘   └───────────┘            │
├─────────────────────────────────────────────────────────────────┤
│                       Offloading API                            │
├───────────────────────────────┬─────────────────────────────────┤
│             CPU               │            Storage              │
│  ┌─────────┐   ┌──────────┐   │  ┌─────────┐   ┌─────────────┐  │
│  │ Manager │   │  Worker  │   │  │ Manager │   │   Worker    │  │
│  │         │   │          │   │  │         │   │             │  │
│  │ ┌─────┐ │   │┌────────┐│   │  │┌───────┐│   │┌───────────┐│  │
│  │ │ LRU │ │   ││Transfer││   │  ││Lookup ││   ││Thread-Pool││  │
│  │ └─────┘ │   ││GPU-CPU ││   │  │└───────┘│   │├───────────┤│  │
│  │         │   │└────────┘│   │  │         │   ││Transfer   ││  │
│  │         │   │          │   │  │         │   ││GPU-CPU    ││  │
│  │         │   │          │   │  │         │   │├───────────┤│  │
│  │         │   │          │   │  │         │   ││POSIX API  ││  │
│  │         │   │          │   │  │         │   │└───────────┘│  │
│  └─────────┘   └──────────┘   │  └─────────┘   └─────────────┘  │
└───────────────────────────────┴─────────────────────────────────┘
```

| 目标 | 延迟 | 容量 | 范围 | 最适合 |
| :--- | :--- | :--- | :--- | :--- |
| CPU 内存 | 低 | 约 250GB/GPU | 单节点 | 高频复用、抢占恢复 |
| 共享存储 | 较高 | TB 级以上 | 跨集群 | 跨节点共享、持久化、超大规模 |

目前，这两种目标作为独立选项运行——请根据工作负载需求选择一种卸载目标。

:::note
**分层 KV 缓存卸载**——块按 GPU → CPU → 存储的统一分层体系流动——正在原生路径中积极开发。
:::


### 树外连接器 {#out-of-tree-connectors}

第三方连接器（参见[其他连接器](#other-connectors)）通过模型服务器的 KV 缓存连接器 API，把外部 KV 缓存引擎适配到模型服务器上。主流服务技术栈中都有这种模式——vLLM 的 V1 Connector API、SGLang 的 HiCache 和 TensorRT-LLM 的 KV Cache Connector API。与原生路径不同，缓存逻辑——索引、内存管理、分层、淘汰和远程存储——位于一个独立的引擎中，通常是单独的进程或服务：

```
┌─────────────────────────────────────────────────────────────────┐
│               模型服务器（vLLM / SGLang / TRT-LLM）             │
├─────────────────────────────────────────────────────────────────┤
│                     KV-Cache Connector API                      │
├─────────────────────────────────────────────────────────────────┤
│                第三方连接器（适配层）                           │
│        把 lookup / store / load 调用桥接到引擎                  │
└───────────────────────────────┬─────────────────────────────────┘
                                │  IPC / 共享内存 / RPC
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                     外部 KV 缓存引擎                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐           │
│  │  缓存索引    │  │  内存管理器  │  │   控制器     │           │
│  │ (token → KV) │  │（锁页内存池）│  │（管理、淘汰）│           │
│  └──────────────┘  └──────────────┘  └──────────────┘           │
│  ┌───────────────────────────────────────────────────┐          │
│  │            异步卸载与传输工作线程                 │          │
│  └───────────────────────────────────────────────────┘          │
├────────────┬──────────────────┬─────────────────────────────────┤
│    CPU     │    本地磁盘      │           远程后端              │
│   DRAM     │  （NVMe 等）     │   （对象存储、KV 存储等）       │
└────────────┴──────────────────┴─────────────────────────────────┘
```

这种模式以部署复杂度换取灵活性：外部引擎独立发布版本，可以在多个推理副本之间协调，并且通常支持更广泛的存储后端。

## 组件 {#components}

### vLLM 原生 CPU 卸载 {#vllm-native-cpu-offloading}

vLLM 的 `OffloadingConnector` 管理 GPU 到 CPU 这一层。它使用硬件 DMA 引擎进行高吞吐传输，对 GPU 计算核心的干扰极小。该连接器：

- 为暂存缓冲区分配锁页（pinned）CPU 内存
- 使用 GPU DMA 异步传输 KV 块，避免干扰 GPU 计算核心。
- 使用连续内存布局（在 vLLM 0.12.0 中引入），把所有层组合到单个物理块中，使传输吞吐提升 4-5 倍

CPU 卸载不需要任何外部基础设施。最简单的启用方式是使用 vLLM 专门的顶层参数：

```bash
--kv-offloading-backend native --kv-offloading-size <size_in_GB>
```

这等价于直接传入 `--kv-transfer-config '{"kv_connector":"OffloadingConnector","kv_role":"kv_both",...}'`——顶层参数只是对连接器 JSON 的便捷封装。

### llm-d 文件系统连接器 {#llm-d-filesystem-connector}

`llmd_fs_backend` 是一个接入 vLLM OffloadingConnector 的存储后端。它把 KV 块以文件形式存储在共享文件系统上，并按需加载回来，以文件系统目录作为已缓存块的索引。

主要特性：

- **与文件系统无关**——依赖标准 POSIX 文件操作，适用于任何文件系统（CephFS、Lustre、IBM Storage Scale、本地 NVMe）
- **跨实例和节点共享 KV**——多个 vLLM 服务器通过访问相同的共享路径复用已缓存的前缀
- **跨重启持久化**——KV 数据在 Pod 重启、重新调度和节点故障后依然保留
- **完全异步 I/O**——读写操作不会阻塞推理路径
- **通过并行实现高吞吐**——I/O 操作在多个工作线程间并行，并采用 NUMA 感知调度
- **对 GPU 干扰极小**——默认使用 GPU DMA，减少对计算内核的干扰

:::note
存储连接器不负责清理或淘汰。存储容量管理必须由底层存储系统或外部控制器处理。参考实现 [PVC Evictor](https://github.com/llm-d/llm-d-kv-cache/tree/v0.9.0/kv_connectors/pvc_evictor) 可以在超出存储阈值时自动清理旧的 KV 缓存文件。
:::


实现细节和高级配置请参阅 [llm-d FS 后端文档](https://github.com/llm-d/llm-d-kv-cache/tree/v0.9.0/kv_connectors/llmd_fs_backend)。

### MooncakeStoreConnector

[Mooncake Store](https://github.com/kvcache-ai/Mooncake) 是基于 Mooncake Transfer Engine 构建的分布式 KV 缓存系统。集中式的 Mooncake Master 管理对象元数据、副本放置、租约和淘汰，而 Transfer Engine 使用 RDMA 或 TCP 在已注册的内存区域之间搬运底层字节。二者结合，把跨节点的 CPU DRAM（以及可选的 SSD/NVMe）汇集成一个共享缓存层，缓存数据路径无需共享文件系统或 PVC。

`MooncakeStoreConnector` 将该存储与 vLLM 的 V1 Connector API 集成。它把 vLLM 按内容寻址的 KV 缓存分块转换为 Mooncake 对象键，并把它们的张量数据映射到 Mooncake 存储和传输的字节范围。这使多个 vLLM 实例能够获取并复用已缓存的前缀，减少冗余的 prefill 计算。

- 在 vLLM 一侧，缓存数据被标识为根据 vLLM 块哈希推导出的、按内容寻址的 KV 缓存块或分块。
- 在 Mooncake 一侧，每个按内容寻址的键标识一个可变长度的字节对象。连接器把该对象映射到一个或多个包含对应 K/V 张量数据的已注册内存范围。

:::note
`MooncakeStoreConnector`（分布式缓存卸载）与 `MooncakeConnector`（用于 P/D 分离的点对点 KV 传输）是不同的。它们共用同一个 Transfer Engine 进行 RDMA 数据搬运，但用途不同，且独立配置。当同时需要 P/D 分离和共享缓存卸载时，可以通过 vLLM 的 `MultiConnector` 组合使用。
:::


#### 架构 {#architecture-1}

该系统由四个组件组成：

- **Mooncake Master**——集中式元数据服务，管理带键的对象、其副本与放置、租约和淘汰。它并不了解 vLLM KV 缓存块的语义。部署清单位于 [`helpers/mooncake-master-store/`](https://github.com/llm-d/llm-d/tree/v0.10.0/helpers/mooncake-master-store)。两种部署模式都需要它。
- **Mooncake Client**——一个独立进程，负责分配 CPU DRAM 和（可选）SSD 存储，把这些资源注册到 Master，并响应来自 vLLM rank 的 RDMA 读写请求。仅在独立存储（standalone-store）模式下使用。部署清单位于 [`helpers/mooncake-client/`](https://github.com/llm-d/llm-d/tree/v0.10.0/helpers/mooncake-client)。
- **Mooncake Transfer Engine**——面向字节的数据搬运器，使用 RDMA 或 TCP 在已注册的 GPU 或 CPU 内存区域与分布式 DRAM/SSD 池之间传输数据。
- **MooncakeStoreConnector**（位于每个 vLLM 进程中）——把 vLLM 按内容寻址的缓存分块转换为 Mooncake 对象键，并把每个对象映射到一个或多个物理内存“地址 + 大小”范围。

有两种部署模式：

| 模式 | 说明 | `global_segment_size` | 组件 |
| :--- | :--- | :--- | :--- |
| **嵌入式（Embedded）** | 每个 vLLM rank 在进程内向分布式池贡献 CPU DRAM | > 0（例如 `"80GB"`） | Master + vLLM |
| **独立存储（Standalone-store）** | 由外部的 Mooncake Client 进程持有 CPU + SSD 池；vLLM rank 只是请求方 | `0` | Master + Client + vLLM |

嵌入式模式部署更简单——DRAM 池会随 vLLM 实例数量自动扩展。独立存储模式通过把资源所有权委托给 Mooncake Client，使存储与计算解耦，并启用 SSD/NVMe 层。举例来说，如果贡献给分布式池的 CPU 并不属于 vLLM 服务器，而需要另一个进程来管理物理内存和磁盘，就需要使用独立存储模式而非嵌入式模式。

#### Mooncake Master

Mooncake Master 负责块元数据、淘汰和快照。主要配置参数（在 [`configmap.yaml`](https://github.com/llm-d/llm-d/blob/v0.10.0/helpers/mooncake-master-store/base/configmap.yaml) 中设置）：

| 参数 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `eviction_high_watermark_ratio` | `0.95` | 池使用率达到 95% 时触发淘汰 |
| `eviction_ratio` | `0.05` | 每个周期淘汰池容量的 5% |
| `default_kv_lease_ttl` | `5000` | 租约 TTL（毫秒） |
| `default_kv_soft_pin_ttl` | `1800000` | 软固定 TTL（毫秒，30 分钟） |
| `enable_snapshot` | `true` | 定期把快照写入 PVC，用于恢复 |
| `snapshot_interval_seconds` | `60` | 快照频率 |

Master 暴露 gRPC（端口 50051）、HTTP 元数据（端口 8080）和 Prometheus 指标（端口 9003）。部署清单请参阅 [`helpers/mooncake-master-store/`](https://github.com/llm-d/llm-d/tree/v0.10.0/helpers/mooncake-master-store)。

#### Mooncake Client

Mooncake Client（`mooncake_client`）是在分布式池中持有物理内存和磁盘的进程。它仅在独立存储模式下使用。

启动时，Client 分配一个 CPU DRAM 段（`--global_segment_size`），并可选地打开一个本地 SSD 路径用于持久化（`--enable_offload=true`）。它把这些资源注册到 Mooncake Master，使其可供整个集群使用。这些分配在进程生命周期内是固定的——Client 不提供在运行时调整段大小、更改 SSD 路径或切换卸载的 API。任何资源规模的变更都需要重启 Client。vLLM rank 从不直接与 Client 通信——当 rank 需要存储或加载块时，它会向 Master 查询块的位置，然后由 Transfer Engine 通过 RDMA 在该 rank 与 Client 的已注册内存之间点对点搬运字节。

Client 内部的两级存储工作方式如下：

- **写入**同步落到 CPU DRAM，并异步持久化到 SSD。
- **读取**先检查 DRAM，DRAM 未命中时再回落到 SSD。
- **淘汰**由 Master 协调——当 DRAM 池达到高水位时，Master 指示 Client 把块溢出到 SSD。

存储与计算解耦意味着：池在 vLLM Pod 重启后依然存在；存储可以放在没有 GPU 的节点上（例如拥有大容量 DRAM 和 NVMe 的纯 CPU 节点）；并且 SSD 层按节点统一管理，而不是按 GPU 管理。部署清单请参阅 [`helpers/mooncake-client/`](https://github.com/llm-d/llm-d/tree/v0.10.0/helpers/mooncake-client)。

#### 内容寻址存储与 PYTHONHASHSEED {#content-addressable-storage-and-pythonhashseed}

KV 缓存块以内容寻址的键存储，这些键由 vLLM 的块哈希机制推导而来。默认情况下，Python 会为每个进程随机化 `hash()` 的种子——如果两个 vLLM 实例对相同的输入 token 计算出不同的哈希，它们就永远无法共享已缓存的块。

所有共享同一个 Mooncake Store 的 vLLM 实例**必须**把 `PYTHONHASHSEED` 设置为同一个固定值：

```bash
PYTHONHASHSEED=0 vllm serve ...
```

#### mooncake_config.json 参考 {#mooncake_configjson-reference}

每个 vLLM 实例都需要一个 Mooncake 配置文件，由 `MOONCAKE_CONFIG_PATH` 环境变量指向。

**嵌入式模式：**

```json
{
  "mode": "embedded",
  "metadata_server": "P2PHANDSHAKE",
  "master_server_address": "mooncake-master-store.mooncake.svc.cluster.local:50051",
  "global_segment_size": "80GB",
  "local_buffer_size": "4GB",
  "protocol": "rdma",
  "device_name": "",
  "enable_offload": false
}
```

**独立存储模式：**

```json
{
  "mode": "standalone-store",
  "metadata_server": "P2PHANDSHAKE",
  "master_server_address": "mooncake-master-store.mooncake.svc.cluster.local:50051",
  "global_segment_size": 0,
  "local_buffer_size": "4GB",
  "protocol": "rdma",
  "device_name": "",
  "enable_offload": true
}
```

| 字段 | 说明 |
| :--- | :--- |
| `mode` | `"embedded"`（进程内 DRAM 池）或 `"standalone-store"`（外部 Client） |
| `metadata_server` | `"P2PHANDSHAKE"`，用于点对点直接交换元数据 |
| `master_server_address` | Mooncake Master 的 gRPC 端点（host:port） |
| `global_segment_size` | 每块 GPU 贡献给池的 CPU 内存。嵌入式模式下必须 > 0，独立存储模式下必须为 0 |
| `local_buffer_size` | 每块 GPU 用于自身操作的私有缓冲区 |
| `protocol` | `"rdma"`（生产环境）或 `"tcp"`（回退） |
| `device_name` | RDMA 设备名称（例如 `"mlx5_0"`）。空字符串表示自动发现 |
| `enable_offload` | 启用 SSD/NVMe 暂存。必须与 `mooncake_master` 和 `mooncake_client` 的参数一致 |

#### 环境变量 {#environment-variables}

| 变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `MOONCAKE_CONFIG_PATH` | （必填） | `mooncake_config.json` 的路径 |
| `PYTHONHASHSEED` | （随机） | 共享同一存储的所有实例必须设置为相同的固定值 |

部署方案请参阅[分层前缀缓存指南——Mooncake Store](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/tiered-prefix-cache/modelserver/gpu/vllm/mooncake-store)。

### 其他连接器 {#other-connectors}

树外引擎通过 llm-d 一侧的通用集成约定与原生路径共存：

- **服务技术栈一侧**——每个引擎都已兼容 vLLM、SGLang（通过 HiCache）和 TensorRT-LLM 中的一个或多个，因此模型服务器通过其标准的 KV 缓存连接器 API 驱动查找、存储和加载。
- **调度一侧**——连接器通过 **KV 事件**与 llm-d 集成：这是一类缓存变更通知，[KV 缓存索引器](./kv-indexer.md)消费它们来维护缓存分布的全局视图，因此无论使用哪种后端都能实现前缀感知路由。

:::note
llm-d 的部署指南目前涵盖 LMCache 和 Mooncake Store。对于 KVBM 和其他兼容连接器的引擎，集成模式是一样的——它们在服务技术栈一侧开箱即用。
:::


部署方案请参阅[分层前缀缓存指南](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/tiered-prefix-cache)。

## 配置 {#configuration}

### CPU 卸载（vLLM 原生） {#cpu-offloading-vllm-native}

| 参数 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `--kv-offloading-backend` | string | - | 设置为 `native` 以使用 vLLM 内置的 CPU 卸载 |
| `--kv-offloading-size` | integer | - | CPU 卸载缓冲区大小（GB，按每个 vLLM 实例计，覆盖其所有工作进程） |

对于高级用法和较旧的 vLLM 版本，也支持等价的 `--kv-transfer-config` JSON 形式。详情请参阅 [vLLM 卸载连接器博客](https://vllm.ai/blog/kv-offloading-connector)。

### 存储卸载（llm-d FS 后端） {#storage-offloading-llm-d-fs-backend}

| 字段 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `shared_storage_path` | string | `/tmp/shared-kv` | KV 缓存文件的基础路径 |
| `block_size` | integer | `256` | 每个文件的 token 数（必须是 GPU 块大小的整数倍） |
| `threads_per_gpu` | integer | `64` | 每块 GPU 的 I/O 工作线程数 |

包括 GDS 模式和环境变量在内的完整配置参考，请参阅 [llm-d FS 后端 README](https://github.com/llm-d/llm-d-kv-cache/tree/v0.9.0/kv_connectors/llmd_fs_backend)。

## 示例 {#examples}

### 使用 vLLM 进行 CPU 卸载 {#cpu-offloading-with-vllm}

```yaml
args:
  - "--model=Qwen/Qwen3-32B"
  - "--tensor-parallel-size=2"
  - "--kv-offloading-backend=native"
  - "--kv-offloading-size=100"
```

### 使用 llm-d FS 后端进行存储卸载 {#storage-offloading-with-llm-d-fs-backend}

```yaml
args:
  - "--model=Qwen/Qwen3-32B"
  - "--tensor-parallel-size=2"
  - "--block-size=16"
  - "--distributed-executor-backend=mp"
  - "--kv-transfer-config"
  - |
    {
      "kv_connector": "OffloadingConnector",
      "kv_role": "kv_both",
      "kv_connector_extra_config": {
        "spec_name": "SharedStorageOffloadingSpec",
        "spec_module_path": "llmd_fs_backend.spec",
        "shared_storage_path": "/mnt/kv-cache/",
        "block_size": 256,
        "threads_per_gpu": 64
      }
    }
volumeMounts:
  - name: kv-cache
    mountPath: /mnt/kv-cache
```

### 使用 MooncakeStoreConnector 进行分布式卸载 {#distributed-offloading-with-mooncakestoreconnector}

在 vLLM 服务器层，可以使用以下配置启动服务：

```yaml
args:
  - "--model=Qwen/Qwen3-32B"
  - "--tensor-parallel-size=2"
  - "--kv-transfer-config"
  - '{"kv_connector":"MooncakeStoreConnector","kv_role":"kv_both"}'
env:
  - name: MOONCAKE_CONFIG_PATH
    value: /etc/mooncake/mooncake_config.json
  - name: PYTHONHASHSEED
    value: "0"
```

完整的 `mooncake_config.json` 参考，请参阅上文的 [MooncakeStoreConnector——mooncake_config.json 参考](#mooncake_configjson-reference)。

## 指标 {#metrics}

FS 后端会填充 vLLM 内置的卸载指标（`vllm:kv_offload_*`），涵盖传输字节数、耗时和大小分布。完整的指标参考请参阅 [llm-d FS 后端文档](https://github.com/llm-d/llm-d-kv-cache/tree/v0.9.0/kv_connectors/llmd_fs_backend#metrics)。

## 性能考量 {#performance-considerations}

**CPU 卸载：**只要 CPU DRAM 大于 GPU HBM 空间，就应始终启用。当缓存能装进 HBM 时，它的开销极小；当装不下时，它带来显著收益——无需重新计算即可恢复被抢占的请求，并以低延迟扩展有效缓存容量。

**存储卸载：**最适合缓存工作集超出单节点容量、跨节点共享有价值（多个副本间重复的系统提示词、智能体工作流），或跨重启的持久化很重要的场景。当存储网络足够快、能够支持低延迟的加载和存储时，存储卸载效果最好。

**存储选型：**FS 后端适用于任何兼容 POSIX 的文件系统，不绑定特定厂商。你的选择需要在以下方面权衡：

- **共享范围**——本地介质（例如 NVMe SSD）只能在单节点内使用；网络或分布式文件系统（例如 NFS、CephFS、Lustre、IBM Storage Scale、Weka、云文件服务）支持跨节点复用。
- **吞吐与延迟**——取决于底层硬件、网络和文件系统配置，而不是 KV 缓存层；对于大规模部署，并行和分布式文件系统通常扩展性最好。

任何 POSIX 文件系统都可以作为候选；对特定部署而言，最佳选择取决于现有存储基础设施、所需规模和延迟目标。

**块大小调优：**较大的 `block_size`（256-512 个 token）能提高 I/O 效率，但需要更长的匹配前缀才能命中缓存。请与典型的前缀长度相匹配。

**分布式卸载（MooncakeStoreConnector）：**最适合跨实例缓存共享至关重要、且具备 RDMA 网络的场景。它消除了对共享文件系统的依赖，并通过 Mooncake Master 提供内置淘汰。大多数部署推荐使用嵌入式模式；独立存储模式会增加复杂度，但能启用 SSD 层并使存储与计算解耦。生产性能需要 RDMA——虽然可以回退到 TCP，但速度会显著变慢。

## 延伸阅读 {#further-reading}

- [分层前缀缓存指南](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/tiered-prefix-cache)——分步部署指南
- [llm-d KV 分离路线图](https://github.com/llm-d/llm-d-kv-cache/issues?q=is%3Aissue%20state%3Aopen%20label%3Aroadmap)——卸载和 KV 缓存管理方面的规划功能与改进
- [llm-d FS 后端](https://github.com/llm-d/llm-d-kv-cache/tree/v0.9.0/kv_connectors/llmd_fs_backend)——实现细节、配置和指标
- [vLLM KV 卸载连接器](https://vllm.ai/blog/kv-offloading-connector)——深入了解 vLLM 的原生卸载
- [Mooncake Store](https://github.com/kvcache-ai/Mooncake)——上游 Mooncake 项目及文档
- [vLLM MooncakeStoreConnector 使用指南](https://docs.vllm.ai/en/v0.23.0/features/mooncake_store_connector_usage/)——vLLM 一侧的配置参考
