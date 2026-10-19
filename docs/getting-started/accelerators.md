# llm-d 支持的加速器

llm-d 支持多家加速器厂商，并且仍在持续扩大覆盖范围。

## 支持情况 {#support}

各类加速器的维护者如下。在每种硬件上的部署细节，请参阅各成熟路径指南。

| 厂商 | 型号 | 维护者 |
| --- | --- | --- |
| AMD | ROCm | Kenny Roche (<Kenny.Roche@amd.com>), Vincent Cave (<Vincent.Cave@amd.com>) |
| CPU | x86_64 | Hongming Zheng (@ZhengHongming888, <hongming.zheng@intel.com>) |
| Google | [TPU](../infrastructure/providers/gke/README.md) | Edwin Hernandez (@Edwinhr716), Cong Liu (@liu-cong, <congliu.thu@gmail.com>) |
| 天数智芯（Iluvatar） | BI-V150 | ShiChun Yu, <shichun.yu@iluvatar.com>, Mengxuan Li(@archlitchi,<mengxuan.li@dynamia.ai>) |
| Intel | XPU | Yuan Wu (@yuanwu2017, <yuan.wu@intel.com>) |
| 沐曦（MetaX） | C500X GPU | Lianjie Zhang (@lianjiezh, <lianjie.zhang@metax-tech.com>), Mengxuan Li (@archlitchi, <mengxuan.li@dynamia.ai>) |
| NVIDIA | GPU | Will Eaton (<weaton@redhat.com>), Greg (<grpereir@redhat.com>) |
| Rebellions | NPU | Jinmoo Seok (@rebel-jinmoo, <jinmoo_seok@rebellions.ai>), Minwook Ahn (@rebel-minwook, <minwook.ahn@rebellions.ai>), Minho Park (@rebel-minhopark, <minho.park@rebellions.ai>) |

## 要求 {#requirements}

我们欢迎加速器厂商参与贡献。要被列为受支持的硬件厂商，最低要求是提供一个公开可获取、能够启动 vLLM 的容器镜像。

要集成进成熟路径，贡献标准更高，**必须满足**：

- 有一名具名维护者，负责保持指南内容为最新
- 每个版本发布时，对指南部署进行手动或自动验证

:::note
我们计划在未来版本中提高要求，为所有硬件指南变体提供持续的 CI 覆盖。

[!NOTE]
社区可以协助，但不负责保持各硬件指南变体的更新。对于硬件支持相关的过时示例和文档，我们保留移除的权利。
:::


## NVIDIA GPU {#nvidia-gpus}

NVIDIA GPU 是所有 llm-d 指南的默认加速器。任何 NVIDIA GPU 均受支持，具体能力由所使用的推理容器镜像决定。除 NVIDIA 设备插件或 DRA 驱动外，无需其他特殊的集群配置。

**CUDA 运行时与驱动要求**

llm-d 当前发布的容器镜像基于 **CUDA 12.9.1** 运行时。未来版本将迁移到 **CUDA 13.0.2**。

CUDA 12.x 与 CUDA 13.x 的驱动兼容范围互不重叠——一个驱动版本只支持其中一个 CUDA 主版本系列，不能同时支持两者：

| CUDA 版本 | 最低驱动版本 | 最高驱动版本 |
|---|---|---|
| CUDA 12.9.1（当前） | 525.60.13 | < 580 |
| CUDA 13.0.2（计划中） | 580.65.06 | 无 |

> 对于使用 CUDA 12.9.1 的当前 llm-d 版本，**推荐驱动版本为 575.x**。它在 CUDA 12.x 兼容的驱动范围内提供最新的功能和修复。
>
> 当 llm-d 迁移到 CUDA 13.0.2 后，最低驱动版本将变为 **580.65.06**。用户应提前规划，在此次迁移前将节点驱动升级到 580 以上。

完整的 CUDA/驱动兼容矩阵请参阅 [CUDA Toolkit 发布说明](https://docs.nvidia.com/cuda/cuda-toolkit-release-notes/index.html)。

## Google TPU

在 GKE 上运行时支持 Google Cloud TPU（v6e、v7）。集群配置请参阅 [GKE 基础设施提供商文档](../infrastructure/providers/gke/README.md)。

在 TPU7x 上，模型服务器可以调度到动态组建的子切片（`2x2x1` 至 `2x4x4`）上，而不必使用静态预配的节点池拓扑。请参阅 [GKE 上的 TPU 动态切片](../infrastructure/providers/gke/dynamic-slicing/README.md)。

## AMD ROCm

AMD GPU 通过 ROCm 获得支持。具体支持的 GPU 型号由推理容器镜像决定。集群配置请使用 AMD 设备插件或 DRA 驱动。

## Intel XPU

支持 Intel Data Center GPU Max 1550 和 Intel BMG GPU（Battlemage G21）。Intel XPU 部署使用 DRA 和统一的加速器类型，可自动为 i915 和 xe 两种驱动处理驱动选择。

集群前提条件方面，请确保已安装 [Intel Resource Drivers for Kubernetes](https://github.com/intel/intel-resource-drivers-for-kubernetes)。

### 使用 RDMA 的 XPU {#xpu-with-rdma}

在 Intel XPU 上进行基于 RDMA 加速 KV 缓存传输的 P/D 分离时，还需满足以下前提条件：

- 一个暴露 `dranet-rdma` 设备类的 RDMA DRA 驱动（例如 [Intel Network Operator for Kubernetes](https://github.com/intel/network-operator)）。
- GPU 与网卡在 PCIe 上对齐，以获得最佳传输性能。
- UCX 传输配置为 `ib,rc,ze_copy`。

RDMA 覆盖层（`modelserver/xpu/vllm-rdma/`）复用标准的 XPU vLLM 基础配置，并为每个 Pod 增加一个 RDMA DRA 声明以及 RDMA 专用的 UCX 传输设置。部署说明请参阅 [P/D 分离指南](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/pd-disaggregation)。

## 天数智芯（Iluvatar） {#iluvatar}

天数智芯 BI-V150 GPU 通过 CoreX 运行时（天数智芯兼容 CUDA 的软件栈）、一个 vLLM 分支以及厂商专用的 NIXL 连接器（`IluNixlConnector`）获得支持。每块板卡为双芯片（每芯片 32&nbsp;GiB，每板卡 64&nbsp;GiB）；当 ix-device-plugin 设置 `splitboard: false` 时，`iluvatar.com/gpu` 按板卡计数，而 vLLM 的并行规模按 CUDA 设备计数（每块板卡 2 个）。除非设置 `VLLM_ENFORCE_CUDA_GRAPH=1`，CoreX 镜像默认使用 eager 模式。P/D 覆盖层在 4 块板卡 / 8 个 CUDA 设备上部署 `Qwen/Qwen3-32B`（1 个 TP=4 的 prefill + 1 个 TP=4 的 decode）。优化基线覆盖层在 4 块板卡 / 8 个 CUDA 设备上部署 `deepseek-ai/DeepSeek-V4-Flash`（DP=8 + EP）。

**UCX 传输（P/D 必需）：**

`IluNixlConnector` 通过 NIXL/UCX 传输 KV 缓存，并设置 `kv_buffer_device=cuda`（KV 保留在显存中）。必须为 UCX 配置支持 CUDA 的传输方式：

```yaml
- name: UCX_TLS
  value: "cuda_copy,cuda_ipc,tcp,self,posix,sysv"
- name: UCX_CUDA_IPC_ENABLE_SAME_PROCESS
  value: "y"
```

如果缺少 `cuda_copy`/`cuda_ipc`，UCX 会把显存误判为主机内存，导致 prefill 引擎在读取 KV 时崩溃（SIGSEGV）。

## 沐曦（MetaX）C500X {#metax-c500x}

社区贡献的成熟路径支持沐曦 C500X GPU。设备插件必须暴露 `metax-tech.com/gpu`。P/D 分离通过 TCP 使用 vLLM 的 `NixlConnector`；请参阅 [P/D 分离指南](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/pd-disaggregation)中的 MetaX 覆盖层（`modelserver/metax/vllm/`）。

## Rebellions NPU

Rebellions NPU 通过 `vllm-rbln` 获得支持。这是一个树外（out-of-tree）的 vLLM 平台插件，注册在 `vllm.platform_plugins` 入口点上，并以可公开拉取的容器镜像形式发布。优化基线覆盖层（`modelserver/npu/vllm/`）以两个副本、每副本一个 NPU 的方式部署 `openai/gpt-oss-120b`，因此路由器会在两个模型服务器之间进行负载均衡。

**集群前提条件：**

- [RBLN NPU Operator](https://docs.rbln.ai/latest/software/system_management/kubernetes/about_npu_operator.html)，它会安装驱动以及 `npu.rebellions.ai` DRA DeviceClass
- Kubernetes 1.34，并提供 `resource.k8s.io/v1` DRA API

**设备分配。** NPU 通过 DRA 申请，而不是通过扩展资源。所有 Rebellions 产品共用一个 DeviceClass，因此只有在 CEL 选择器中按 `productName` 过滤，声明才能落到特定的 NPU 上——请参阅覆盖层中的 `resource-claim-template.yaml`。如果省略该选择器，声明可能绑定到与指南测量时不同的 Rebellions 产品上。

**NUMA 对齐。** 该覆盖层只申请一个 NPU，不申请网卡，因此不设置 `resource.kubernetes.io/numaNode` 匹配约束——这种约束需要在同一个声明中有两个或以上的请求才能绑定在一起。

**前缀缓存已关闭，因此需要叠加 NPU 路由器配置。** 该运行时会对滑动窗口模型禁用前缀缓存，而 `openai/gpt-oss-120b` 正是此类模型：即使启用，所有查询的命中数也都是 0。指南默认的调度配置是前缀缓存感知的，因此请在指南自身的配置值之后应用 [`router/npu.rbln.values.yaml`](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/optimized-baseline/router/npu.rbln.values.yaml)，回退为仅使用负载打分器。一旦运行时在此场景下支持前缀缓存，该标志和该文件都会被移除。

**运行指南步骤时请设置 `MODEL`。** 该覆盖层固定使用 `openai/gpt-oss-120b`，而指南默认的 `MODEL` 是 `Qwen/Qwen3-32B`。请导出 `MODEL=openai/gpt-oss-120b`，使验证和基准测试步骤指向实际部署的模型。

**本版本不涵盖的内容：** [快速模型启动（fast model actuation）](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/fast-model-actuation-base)，因为该运行时不支持休眠与唤醒；LoRA 适配器；以及多模态模型——在该运行时上，多模态需要一条无法与 KV 连接器同时运行的代码路径。

**验证。** 上面列出的维护者会在每个 llm-d 版本标签发布时，使用发布镜像部署一次优化基线覆盖层并记录结果。

## CPU 推理 {#cpu-inferencing}

对于没有 GPU 加速器的部署，支持纯 CPU 推理。要求第 4 代 Intel Xeon 处理器（Sapphire Rapids）或更新型号，或同等的 AMD 处理器。每个副本至少需要 64 个 CPU 核心和 64GB 内存。

**运行指南步骤时请设置 `MODEL`。** CPU 覆盖层部署的是 `meta-llama/Llama-3.2-3B-Instruct`，而指南默认的 `MODEL` 是 `Qwen/Qwen3-32B`。请导出 `MODEL=meta-llama/Llama-3.2-3B-Instruct`，使验证和基准测试步骤指向实际部署的模型。
