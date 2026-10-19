# 在 Google Kubernetes Engine（GKE）上运行 llm-d

本文介绍如何配置 GKE 集群，以使用 llm-d 运行高性能 LLM 推理。

## 前提条件 {#prerequisites}

llm-d 在 GKE 上经过以下配置的测试：

* 机器类型：A3、A4、A4X、ct5p、ct5lp、ct6e
* 版本：GKE 1.33.4+

## 集群配置 {#cluster-configuration}

GCP 集群应按以下设置配置：

* 满足[启用 GKE Inference Gateway](https://cloud.google.com/kubernetes-engine/docs/how-to/deploy-gke-inference-gateway#prepare-environment)的全部前提条件

### GPU {#gpus}

对于 A3 机器，如果计划使用 Prefill/Decode 分离，请部署集群并[使用 TCPX 配置高性能网络](https://cloud.google.com/kubernetes-engine/docs/how-to/gpu-bandwidth-gpudirect-tcpx)。

对于 A3 Ultra、A4 和 A4X 机器，请按照[创建带 GPU 的 AI 优化 GKE 集群的步骤](https://cloud.google.com/ai-hypercomputer/docs/create/gke-ai-hypercompute)操作，并启用 GPUDirect RDMA。

### GKE 上的 GPU 动态资源分配（DRA）与 DRANET（RoCE） {#gpu-dynamic-resource-allocation-dra-and-dranet-roce-on-gke}

本节提供在 GKE 上部署 P/D（Prefill/Decode）分离的具体说明，使用针对 NVIDIA GPU 的**动态资源分配（DRA）**和 RDMA（RoCE）网络（例如 A3 Ultra 上的 NVIDIA H200 GPU）。

:::note
最新更新和详细说明请以 GCP 官方文档为准：

* [GKE AI Hypercomputer 自定义预配](https://docs.cloud.google.com/ai-hypercomputer/docs/create/gke-ai-hypercompute-custom)
* [配置 GPU 动态资源分配（DRA）](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/set-up-dra)
* [使用 GKE 托管的 DRANET 分配网络资源](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/allocate-network-resources-dra#use-rdma-interfaces-gpu)
:::


#### 前提条件 {#prerequisites-1}

设置环境变量：

```bash
export PROJECT="<your GCP project>"
export LOCATION="<your GCP location>"
export CLUSTER_NAME="<your cluster name>"
export NAMESPACE="llm-d-pd-disaggregation"
```

#### 1. 创建集群（托管 DRANET） {#1-create-cluster-managed-dranet}

GKE 网络 DRA（**DRANET**）开箱即支持托管网络，因此无需安装自定义网络驱动。不过，创建集群时**必须**启用 **Dataplane V2**：

```bash
gcloud container clusters create "${CLUSTER_NAME}" \
    --enable-dataplane-v2 \
    --managed-otel-scope=COLLECTION_AND_INSTRUMENTATION_COMPONENTS \
    --location="${LOCATION}" \
    --project="${PROJECT}"
```

:::note
**在现有 GKE 集群上部署：**
如果你是在现有集群上部署而不是新建集群，配置路径取决于是否启用了 Dataplane V2：

* **已启用 Dataplane V2 的现有集群：**可以跳过第 1 步（创建集群），直接进入第 2 步（创建节点池），并使用自动的 GKE 托管 DRANet 配置（`--accelerator-network-profile=auto`）。
* **未启用 Dataplane V2 的现有集群：**不支持 GKE 托管的自动 DRANet。你**不能**直接使用下面***第 2 步***中的节点池创建命令。相反，你必须**手动**为额外的网络接口（网卡）配置和管理多网络：手动创建子网，并把节点池的网络接口映射到这些子网上，详见 GKE 的[为 Pod 配置多网络支持](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/setup-multinetwork-support-for-pods)文档。手动预配好子网和节点池后，直接进入**第 3 步**。
:::


#### 2. 创建节点池（启用 DRANET 并禁用默认 GPU 驱动） {#2-create-node-pool-enable-dranet--disable-default-gpu-driver}

GPU DRA 目前尚未完全由 GKE 托管。因此，必须通过 `--accelerator gpu-driver-version=disabled` 禁用自动 GPU 驱动和默认的 GPU 设备插件。

通过配置 `--accelerator-network-profile=auto` 并添加 `cloud.google.com/gke-networking-dra-driver=true` 节点标签来启用 GKE 托管的 **DRANET**：

```bash
gcloud beta container node-pools create a3u-dra-pool-1 \
  --project="${PROJECT}" \
  --location="${LOCATION}" \
  --cluster="${CLUSTER_NAME}" \
  --accelerator type=nvidia-h200-141gb,count=8,gpu-driver-version=disabled \
  --machine-type=a3-ultragpu-8g \
  --num-nodes=2 \
  --spot \
  --accelerator-network-profile=auto \
  --node-labels="cloud.google.com/gke-networking-dra-driver=true,goog-gke-accelerator-type=nvidia-h200-141gb,nvidia.com/gpu.present=true,cloud.google.com/gke-nvidia-gpu-dra-driver=true,gke-no-default-nvidia-gpu-device-plugin=true"
```

#### 3. 安装 NVIDIA 驱动与 GPU DRA 驱动 {#3-install-nvidia--gpu-dra-drivers}

由于禁用了自动 GPU 驱动管理，必须手动安装 NVIDIA 驱动和 NVIDIA GPU DRA 驱动。

**3.1 安装 NVIDIA 驱动**

应用预装的 COS NVIDIA 驱动 DaemonSet：

```bash
kubectl apply -f https://raw.githubusercontent.com/GoogleCloudPlatform/container-engine-accelerators/master/nvidia-driver-installer/cos/daemonset-preloaded.yaml
```

**3.2 安装 NVIDIA GPU DRA 驱动**

安装官方的 NVIDIA DRA 驱动：

```bash
helm install nvidia-dra-driver-gpu nvidia/nvidia-dra-driver-gpu \
    --version="25.8.0" --create-namespace --namespace=nvidia-dra-driver-gpu \
    --set nvidiaDriverRoot="/home/kubernetes/bin/nvidia/" \
    --set gpuResourcesEnabledOverride=true \
    --set resources.computeDomains.enabled=false \
    --set kubeletPlugin.priorityClassName="" \
    --set 'kubeletPlugin.tolerations[0].key=nvidia.com/gpu' \
    --set 'kubeletPlugin.tolerations[0].operator=Exists' \
    --set 'kubeletPlugin.tolerations[0].effect=NoSchedule'
```

**3.3 验证 DRA 设备是否就绪**

确认 DRA 驱动 Pod 正在运行，并且 `ResourceSlices` 已成功填充 `gpu.nvidia.com` 和 `mrdma.google.com` 设备：

```bash
kubectl get pods -n nvidia-dra-driver-gpu
```

```console
NAME                                         READY   STATUS    RESTARTS   AGE
nvidia-dra-driver-gpu-kubelet-plugin-52cdm   1/1     Running   0          46s
```

```bash
kubectl get resourceslices -o yaml
```

<details>
<summary><b>点击查看预期输出</b></summary>

```yaml
apiVersion: v1
items:
- apiVersion: resource.k8s.io/v1
  kind: ResourceSlice
  metadata:
    name: gpu-slice-0
  spec:
    devices:
    - attributes:
        productName:
          string: NVIDIA H200
        resource.kubernetes.io/pcieRoot:
          string: pci0000:00
        type:
          string: gpu
      name: gpu-0
    driver: gpu.nvidia.com
    nodeName: a3u-dra-pool-1-node
- apiVersion: resource.k8s.io/v1
  kind: ResourceSlice
  metadata:
    name: nic-slice-0
  spec:
    devices:
    - attributes:
        resource.kubernetes.io/pcieRoot:
          string: pci0000:00
        type:
          string: nic
      name: nic-0
    driver: mrdma.google.com
    nodeName: a3u-dra-pool-1-node
```

</details>

### GKE A4X（GB200）配置 {#gke-a4x-gb200-setup}

对于 GKE A4X（NVIDIA GB200）集群，请使用继承自 `gke/base` 的 `gke/a4x` 覆盖层路径（`modelserver/gpu/vllm/gke/a4x`）部署模型服务器。该配置通过 DRANet（`mrdma.google.com`）启用原生 InfiniBand RDMA 网络和 GPUDirect 硬件加速：

* **硬件互联**：配置 `UCX_TLS=rc_mlx5,rc,cuda_copy,cuda_ipc,sm,shm,self`，以使用硬件加速的 InfiniBand 传输。
* **DRANet 资源声明**：使用 `gke-rdma-nic-template` 申请 DRANet（`mrdma.google.com`）接口，同时通过 NVIDIA 设备插件（`nvidia.com/gpu`）管理 GPU。

## 缓解 Hugging Face 模型下载限流 {#mitigating-hugging-face-model-download-rate-limiting}

在 GKE 集群上部署大规模模型推理（例如多副本的 prefill 和 decode 部署）时，多个 Pod 并发下载模型权重可能触发 Hugging Face 的 HTTP 429 限流错误，导致容器启动超时。

关于模型来源、缓存和启动优化，请参阅[模型加载与启动加速运维指南](../../../operations/model-loading-and-startup.md)。

### 集成 Google Cloud Storage（生产环境推荐） {#google-cloud-storage-integration-recommended-for-production}

对于大型生产工作负载，请把模型权重存储在 Google Cloud Storage（GCS）存储桶中，并直接挂载到 Pod。这样在 Pod 扩缩时就完全摆脱了对外部 Hugging Face 网络的依赖。

分步说明请参阅 [GKE Hugging Face GCS 传输指南](https://gke-ai-labs.dev/docs/tutorials/storage/hf-gcs-transfer/)。

### TPU {#tpus}

所有 TPU 机器请参照 [GKE 中的 TPU 文档](https://cloud.google.com/kubernetes-engine/docs/how-to/tpus)。

对于 Ironwood（TPU7x），GKE 支持动态切片：TPU 容量以固定的子块形式预配，并在调度时被划分为符合工作负载形态的子切片（例如 `2x2x1`、`2x2x2`），从而改善恢复时间、启动延迟和集群利用率。集群配置以及相应的 llm-d 模型服务器方案，请参阅 [GKE 上的 TPU 动态切片](./dynamic-slicing/README.md)。

### 监控 {#monitoring}

我们建议启用 Google Managed Prometheus 和[自动应用监控](https://cloud.google.com/kubernetes-engine/docs/how-to/configure-automatic-application-monitoring)，为集群上部署的 vLLM 开启自动指标采集和仪表盘；并启用[托管 OpenTelemetry](https://cloud.google.com/kubernetes-engine/docs/how-to/managed-otel-gke)，以 OTLP 格式采集 llm-d 技术栈的追踪等遥测数据。

创建集群时，`--managed-otel-scope=COLLECTION_AND_INSTRUMENTATION_COMPONENTS` 参数会在集群上启用托管 OpenTelemetry。把范围设置为 `COLLECTION_AND_INSTRUMENTATION_COMPONENTS`，GKE 会同时部署 OpenTelemetry Collector（位于 `gke-managed-otel` 命名空间）和 Instrumentation 自定义资源定义（CRD），后者用于把 OpenTelemetry 配置自动注入到工作负载 Pod 中。

## 工作负载配置 {#workload-configuration}

### GPU {#gpus-1}

#### 在 GKE 工作负载 Pod 上配置 RDMA 支持 {#configuring-support-for-rdma-on-gke-workload-pods}

GCP 在 A3 Ultra 及更新的 GPU 主机上通过 RoCE 提供 CX-7 支持。

需要使用高速节点间网络进行 P/D 分离或宽专家并行的模型服务器，需要在工作负载 Pod 上申请 RDMA 资源。集群创建指南介绍了 Pod 访问 RDMA 设备所需的修改（例如[针对 A3 Ultra / A4](https://cloud.google.com/ai-hypercomputer/docs/create/gke-ai-hypercompute-custom#configure-pod-manifests-rdma)）。

此外，使用基于 NVIDIA NVSHMEM 的 DeepEP 的专家并行部署，需要以 `privileged: true` 运行 Pod 才能建立 GPU 发起的 RDMA 连接；或者通过[手动安装 GPU 驱动](https://cloud.google.com/kubernetes-engine/docs/how-to/gpus#installing_drivers)，在 NVIDIA 内核设置中启用 `PeerMappingOverride=1`。

***注意：***虽然 GDRCopy 支持 CPU 发起的 RDMA 连接，但目前我们尚未测得这种配置带来的收益，因此推荐使用默认的 GPU 发起方式。可以在容器上设置 `NVSHMEM_DISABLE_GDRCOPY=1` 环境变量，以关闭 NVSHMEM 初始化时的 GDRCopy 警告。

#### 确保带 RDMA 的 Pod 副本按网络拓扑感知方式调度 {#ensuring-network-topology-aware-scheduling-of-pod-replicas-with-rdma}

请选择合适的节点选择器，确保多主机副本都位于同一个网络结构上。对于许多部署而言，你的 A3 Ultra 或更新机型的预留会位于单个可用区内。这能保证连通性，但不一定能达到期望的总吞吐。

在启用 RDMA 的 GKE 节点上，`cloud.google.com/gce-topology-block` 标签标识处于同一高速网络中的机器，可以作为更高层编排的基础原语，把一个多主机副本中的 Pod 分组到同一个 RDMA 网络中。

对于多主机训练和推理工作负载，GKE 推荐使用[结合 Kueue 和 LeaderWorkerSet 的拓扑感知调度](https://cloud.google.com/ai-hypercomputer/docs/workloads/schedule-gke-workloads-tas)。

对于较小规模的专家并行部署（2 或 4 节点副本），我们没有观察到要求副本中所有节点位于同一个 `cloud.google.com/gce-topology-subblock` 能带来显著收益。我们建议设置一条 Pod 亲和性规则，把所有 Pod 放在同一个 `cloud.google.com/gce-topology-block` 中：

```yaml
  affinity:
    podAffinity:
      # 子块亲和性无法保证副本中的所有 Pod
      # 都位于同一个子块中，但比随机分散要好
      preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 2
        podAffinityTerm:
          labelSelector:
            matchLabels:
              app: vllm-deepseek-ep
          matchLabelKeys:
          - component
          topologyKey: cloud.google.com/gce-topology-block
      - weight: 1
        podAffinityTerm:
          labelSelector:
            matchLabels:
              app: vllm-deepseek-ep
          matchLabelKeys:
          - component
          topologyKey: cloud.google.com/gce-topology-subblock
```

## 已知问题 {#known-issues}

### GKE 上 vLLM 0.10.0 出现 `Undetected platform` {#undetected-platform-on-vllm-0100-on-gke}

GKE 托管的 GPU 驱动会自动把配置的节点 CUDA 驱动挂载到 `/usr/local/nvidia`。vLLM 等 CUDA 应用的 `LD_LIBRARY_PATH` 中必须包含 `/usr/local/nvidia`，否则无法找到所需的 CUDA 库。

在 vLLM 中，这会导致启动失败，并输出以下日志：

```text
INFO 05-28 14:02:21 [__init__.py:247] No platform detected, vLLM is running on UnspecifiedPlatform
...
INFO 05-28 14:02:26 [config.py:1909] Disabled the custom all-reduce kernel because it is not supported on current platform.
Traceback (most recent call last):
  File "<frozen runpy>", line 198, in _run_module_as_main
  File "<frozen runpy>", line 88, in _run_code
  File "/usr/local/lib/python3.12/dist-packages/vllm/entrypoints/openai/api_server.py", line 1372, in <module>
    parser = make_arg_parser(parser)
  File "/usr/local/lib/python3.12/dist-packages/vllm/entrypoints/openai/cli_args.py", line 246, in make_arg_parser
    parser = AsyncEngineArgs.add_cli_args(parser)
  File "/usr/local/lib/python3.12/dist-packages/vllm/engine/arg_utils.py", line 1565, in add_cli_args
    parser = EngineArgs.add_cli_args(parser)
  File "/usr/local/lib/python3.12/dist-packages/vllm/engine/arg_utils.py", line 825, in add_cli_args
    vllm_kwargs = get_kwargs(VllmConfig)
  File "/usr/local/lib/python3.12/dist-packages/vllm/engine/arg_utils.py", line 174, in get_kwargs
    default = field.default_factory()
  File "<string>", line 4, in __init__
  File "/usr/local/lib/python3.12/dist-packages/vllm/config.py", line 2245, in __post_init__
    raise RuntimeError(
RuntimeError: Failed to infer device type, please set the environment variable `VLLM_LOGGING_LEVEL=DEBUG` to turn on verbose logging to help debug the issue.
```

该问题的根本原因是：作为 vLLM 容器镜像基础的 CUDA 12.8 和 12.9 NVIDIA Docker 镜像，把已安装 CUDA 驱动的位置从 `/usr/local/nvidia` 改到了 `/usr/local/cuda`，并修改了 `LD_LIBRARY_PATH`。因此，vLLM 找不到来自驱动挂载目录的库。

llm-d 容器镜像以及提交 [5546acb463243ce](https://github.com/vllm-project/vllm/commit/5546acb463243ce3c166dc620c764a93351b7c69) 之后的 vLLM 中已包含变通方案。自定义 vLLM 镜像的用户需要确保镜像中的 LD_LIBRARY_PATH 包含 `/usr/local/nvidia/lib64`。

#### vLLM 0.11.0 需要 Google InfiniBand 1.10（gIB） {#google-infiniband-110-required-for-vllm-0110-gib}

vLLM v0.11.0 及更新版本需要 NCCL 2.27，而 gIB 1.10+ 才支持它。请参阅集群配置中的相应章节安装 RDMA 二进制并配置 NCCL（例如[针对 A3 Ultra / A4](https://cloud.google.com/ai-hypercomputer/docs/create/gke-ai-hypercompute-custom#install-rdma-configure-nccl)）。要获得 1.10，请至少使用这个 [1.10 合并请求](https://github.com/GoogleCloudPlatform/container-engine-accelerators/pull/511)中所述版本的 RDMA 安装器 DaemonSet。

#### DeepEP 初始化时 NVSHMEM 报告 `Unable to create ah.` {#nvshmem-reports-unable-to-create-ah-on-initialization-for-deepep}

部分 NVSHMEM 版本（3.3.20 至 3.4.5）存在一个缺陷：传给设备初始化的 `ibv_ah_attr` 结构体在代码中没有被清零。在会校验 `static_rate` 字段取值的 Linux 内核版本上，使用 DeepEP 内核进行宽专家并行时，可能会因 `EINVAL` 而启动失败，并报告 `Unable to create ah.`。

为绕过这个问题，llm-d 对 NVSHMEM 应用了一个[补丁](https://github.com/llm-d/llm-d/pull/407)，在把该结构体传给内核之前对其调用 `memset(..., 0, ...)`。

#### DeepEP 中 NVSHMEM 因 `no active IB device that supports GPU-initiated communication` 无法初始化 IBGDA 传输 {#nvshmem-fails-to-initialize-ibgda-transport-due-to-no-active-ib-device-that-supports-gpu-initiated-communication-for-deepep}

使用 DeepEP 内核启动宽专家并行部署时，如果容器镜像（尤其是 Ubuntu）没有按照 NVIDIA 的建议基于 Mellanox OFED 驱动编译，可能会启动失败并报以下错误：

```text
/tmp/nvshmem_src/src/modules/transport/ibgda/ibgda.cpp 3888 no active IB device that supports GPU-initiated communication is found, exiting...

/tmp/nvshmem_src/src/host/transport/transport.cpp:nvshmemi_transport_init:282: init failed for transport: IBGDA
```

基于 RHEL UBI 的默认 llm-d 镜像不受影响。[Issue 412](https://github.com/llm-d/llm-d/issues/412) 跟踪了对基于 Ubuntu 的镜像的更新。

要在自行构建的镜像中解决此问题，请在安装 `libibverbs-dev` 或其他 `rdma-core-devel` 软件包之前，添加 Mellanox OFED 的 apt 仓库：

```bash
wget -qO - https://www.mellanox.com/downloads/ofed/RPM-GPG-KEY-Mellanox | apt-key add -
cd /etc/apt/sources.list.d/ && wget https://linux.mellanox.com/public/repo/mlnx_ofed/24.10-0.7.0.0/ubuntu22.04/mellanox_mlnx_ofed.list
```
