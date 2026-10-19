# 在 Azure Kubernetes Service 上部署 llm-d

## 状态与范围 {#status-and-scope}

本指南介绍在支持 RDMA 的 Azure ND 系列 GPU 节点上支撑 llm-d 的 AKS 基础设施。按照 Azure 虚拟机 SKU 的命名约定，名称中能力部分的小写 `r` 表示支持 RDMA。这类能力部分的示例包括 `asr`、`amsr` 和 `isr`。

示例包括：

- `Standard_ND96asr_v4`；
- `Standard_ND96amsr_A100_v4`；
- `Standard_ND96isr_H100_v5`；以及
- `Standard_ND96isr_H200_v5`。

请务必确认所选 SKU 在目标区域支持 InfiniBand。不要仅仅因为某个通用 GPU SKU 带有 NVIDIA GPU 就选用它。

支持级别如下：

| SKU 类别 | 在本指南中的状态 |
| --- | --- |
| 带有 `r` 标记、支持 RDMA 的 ND 系列 SKU | 目标部署类别 |
| `Standard_ND96isr_H100_v5` | 完全验证的参考配置 |
| 其他 A100、H100 或 H200 ND 系列 RDMA SKU | 使用本流程，然后运行全部验证关卡 |
| GB200 或 GB300 机架级 SKU | 使用本流程加上受支持的 ICG/ICB 放置路径；验证特定于该 SKU 的镜像和拓扑 |

H100 示例中使用的 llm-d 部署模式同样适用于受支持的 GB 系列 GPU 节点。请使用 AKS 托管的 GPU 支持、DRANET 设备声明、`IPC_LOCK`，以及 NCCL 和 NIXL 验证关卡。对于 GB 系列部署，还应使用可用的机架感知放置控制。

该基础设施流程已在以下配置上验证：

| 组件 | 已验证的配置 |
| --- | --- |
| AKS | Kubernetes 1.34，提供 `resource.k8s.io/v1` DRA API |
| 已验证的 GPU 节点 | `Standard_ND96isr_H100_v5`，8 块 H100 GPU |
| 节点操作系统 | Ubuntu 24.04 |
| 最低节点镜像 | `AKSUbuntu-2404gen2containerd-202608.14.0` |
| GPU 支持 | AKS 托管的 NVIDIA 驱动和 GPU 资源注册 |
| 主机 RDMA | Ubuntu Azure 内核自带的 `mlx5` 和 RDMA 模块 |
| GPUDirect 机制 | DMA-BUF |
| 网卡分配 | DRANET v1.3.0，配合 Kubernetes 动态资源分配（DRA） |
| 工作负载内存锁定 | `IPC_LOCK` 能力 |

本流程为 llm-d 准备 AKS 环境。基础设施测试包括原始 RDMA、NCCL 和 NIXL。持久运行的 llm-d 服务部署和推理请求属于单独的应用测试。

该部署模型适用于支持 RDMA 的 ND 系列 GPU SKU。记录的测试结果仅针对已验证的 H100 配置。请针对每种 GPU SKU、AKS 节点镜像和驱动版本运行相同的验证关卡。

请使用 `AKSUbuntu-2404gen2containerd-202608.14.0` 或更新的 Ubuntu 24.04 AKS 节点镜像。更新的节点镜像应当也能适用本流程。每次更新节点镜像后，请在部署 llm-d 之前运行验证关卡。

## 前提条件 {#prerequisites}

你需要：

- 一个 AKS 集群；
- 所选的支持 RDMA 的 ND 系列 GPU SKU 的配额和容量；
- 两个 GPU 节点，用于节点间 RDMA 以及 prefill/decode 测试；
- `az`、`kubectl`、`helm` 和 `jq`；
- 集群管理员权限；以及
- 一个暴露 `resource.k8s.io/v1` 的 Kubernetes API 服务器。

设置部署参数：

```bash
export AZURE_SUBSCRIPTION_ID='<subscription-id>'
export AZURE_RESOURCE_GROUP='<resource-group>'
export AKS_CLUSTER_NAME='<cluster-name>'
export GPU_NODE_POOL='<node-pool-name>'
export GPU_VM_SIZE='Standard_ND96isr_H100_v5'

az account set --subscription "${AZURE_SUBSCRIPTION_ID}"
az aks get-credentials \
  --resource-group "${AZURE_RESOURCE_GROUP}" \
  --name "${AKS_CLUSTER_NAME}"

kubectl config current-context
```

在安装 DRANET 之前确认 DRA API：

```bash
kubectl api-resources --api-group=resource.k8s.io
```

输出必须包含以下 `v1` 版本的资源：

```text
deviceclasses
resourceclaims
resourceclaimtemplates
resourceslices
```

## 1. 创建支持 RDMA 的 ND 系列节点池 {#1-create-the-rdma-capable-nd-series-node-pool}

使用 Ubuntu 24.04 和 AKS 托管的 GPU 技术栈。下面的命令是一个模板。运行之前，请根据你的环境检查可用区、磁盘设置、自动扩缩容和容量需求。

```bash
az aks nodepool add \
  --subscription "${AZURE_SUBSCRIPTION_ID}" \
  --resource-group "${AZURE_RESOURCE_GROUP}" \
  --cluster-name "${AKS_CLUSTER_NAME}" \
  --name "${GPU_NODE_POOL}" \
  --node-count 2 \
  --node-vm-size "${GPU_VM_SIZE}" \
  --os-sku Ubuntu2404 \
  --enable-managed-gpu true \
  --node-taints sku=gpu:NoSchedule
```

`--enable-managed-gpu=true` 选择完整的 AKS 托管 GPU 体验。此后 AKS 会管理 NVIDIA 驱动、Kubernetes 设备插件、DCGM 指标导出器以及 GPU 健康监控。参见[创建 AKS 托管的 GPU 节点池](https://learn.microsoft.com/azure/aks/aks-managed-gpu-nodes)。

建议使用 `sku=gpu:NoSchedule` 污点，把一般工作负载挡在 GPU 节点之外。这不是 RDMA 的要求。GPU 工作负载必须包含相应的容忍。

托管 GPU 体验目前是预览功能，可能需要 AKS 预览扩展：

```bash
az extension add --upgrade --name aks-preview
```

## 2. 已验证的主机与 GPU 基线 {#2-validated-host-and-gpu-baseline}

H100 验证在 `Standard_ND96isr_H100_v5` 节点上确认了所需的基线。最终的一致性测试使用的是保留下来的一对跨池节点。详细的主机检查使用了两台虚拟机规格、节点镜像、内核和 GPU 驱动都相同的节点。

| 项目 | 确认结果 |
| --- | --- |
| GPU 清单 | 每节点 8 块 NVIDIA H100 80 GB GPU |
| Kubernetes GPU 资源 | 每节点 8 个可分配的 `nvidia.com/gpu` 资源 |
| 节点操作系统 | Ubuntu 24.04.4 LTS |
| 内核 | `6.8.0-1064-azure` |
| NVIDIA 驱动 | AKS 托管的 NVIDIA 开源内核驱动 `580.159.04` |
| RDMA 模块 | `mlx5_core`、`mlx5_ib`、`ib_core` 和 `ib_uverbs`，从 `linux-modules-6.8.0-1064-azure` 加载 |
| InfiniBand 设备 | 8 个工作负载设备，`mlx5_0` 到 `mlx5_7`，状态为 Active 且 LinkUp，速率 400 Gb/s NDR |
| DMA-BUF | NCCL 报告 `DMA-BUF is available` 并使用 `GDRDMA` |
| Containerd NRI | 已启用，`disable = false`；`/var/run/nri/nri.sock` 存在 |

Kubernetes 节点结果如下：

```text
NAME                                  READY   GPU   OS                   KERNEL
aks-managedh100-48873085-vmss000007   True    8     Ubuntu 24.04.4 LTS   6.8.0-1064-azure
aks-h100xpg-32240380-vmss000001       True    8     Ubuntu 24.04.4 LTS   6.8.0-1064-azure
```

详细的主机检查在两台被检查的 H100 主机上都记录到以下模块状态：

```text
mlx5_core loaded=yes package=linux-modules-6.8.0-1064-azure
mlx5_ib   loaded=yes package=linux-modules-6.8.0-1064-azure
ib_core   loaded=yes package=linux-modules-6.8.0-1064-azure
ib_uverbs loaded=yes package=linux-modules-6.8.0-1064-azure
```

8 个工作负载 InfiniBand 端口报告的模式如下：

```text
mlx5_0 state=ACTIVE physical_state=LinkUp link_layer=InfiniBand rate=400 Gb/sec
...
mlx5_7 state=ACTIVE physical_state=LinkUp link_layer=InfiniBand rate=400 Gb/sec
```

NCCL 确认了 GPU 直连路径：

```text
DMA-BUF is available on GPU device 0
GPU Direct RDMA Enabled for HCA 0 'mlx5_0'
Channel 00/0 ... via NET/IB/0/GDRDMA
```

生效的 containerd 配置确认了 NRI 支持：

```text
[plugins.'io.containerd.nri.v1.nri']
  disable = false
  socket_path = '/var/run/nri/nri.sock'

/var/run/nri/nri.sock: socket, owner=root:root, mode=755
```

## 3. 安装 DRANET {#3-install-dranet}

DRANET 为 InfiniBand 网卡提供 Kubernetes DRA 分配与隔离。它不会安装主机网卡驱动。

AKS 托管的 DRANET 支持仍在开发中。预计 AKS 将来会提供托管的 DRANET 方案。在该服务可用之前，你必须在集群中自行安装和运维 DRANET。

创建工作负载命名空间：

```bash
kubectl create namespace llm-d-infra \
  --dry-run=client -o yaml | kubectl apply -f -
```

创建 `dranet-values.yaml`：

```yaml
image:
  repository: registry.k8s.io/networking/dranet
  tag: v1.3.0
  pullPolicy: IfNotPresent

nodeSelector:
  kubernetes.azure.com/agentpool: <node-pool-name>

args:
  cloudProviderHint: AZURE
  moveIBInterfaces: false

resources:
  requests:
    cpu: 100m
    memory: 50Mi
  limits:
    memory: 256Mi
```

`moveIBInterfaces: false` 会把 IP over InfiniBand 接口保留在主机上，并让 DRANET 注入已分配的 RDMA 字符设备。

本指南使用 AKS 提供的 `kubernetes.azure.com/agentpool=<node-pool-name>` 标签，不需要自定义的 `llm-d.ai/*` 标签。如果一个 DRANET 部署必须覆盖多个 RDMA 节点池，可以选择使用由运维人员管理的公共标签来选中所有这些节点池。

安装固定版本的 Chart：

```bash
helm upgrade --install dranet \
  oci://registry.k8s.io/networking/charts/dranet \
  --version v1.3.0 \
  --namespace kube-system \
  --values dranet-values.yaml \
  --wait \
  --timeout 10m
```

确认 DRANET 只运行在预期的 RDMA 节点上：

```bash
kubectl get daemonset dranet -n kube-system -o wide
kubectl get pods -n kube-system \
  --selector=app.kubernetes.io/name=dranet \
  -o wide
```

## 4. 创建 RDMA DeviceClass {#4-create-the-rdma-deviceclass}

该 `DeviceClass` 只接受由 `dra.net` 驱动发布的、支持 RDMA 的设备：

```yaml
apiVersion: resource.k8s.io/v1
kind: DeviceClass
metadata:
  name: dranet.net
spec:
  selectors:
    - cel:
        expression: >-
          device.driver == "dra.net" &&
          device.attributes["dra.net"].rdma == true
```

应用该对象：

```bash
kubectl apply -f dranet-device-class.yaml
```

随后 DRANET 会为每个选中的 ND 系列节点发布一个 `ResourceSlice`。设备数量因 SKU 而异。在创建整节点声明之前，请先确认并记录预期的数量。H100 参考配置有 8 个设备。

```bash
kubectl get resourceslices.resource.k8s.io -o json | jq -r '
  .items[]
  | select(.spec.driver == "dra.net")
  | [
      .spec.nodeName,
      (.spec.devices | length),
      .spec.devices[0].attributes["azure.dra.net/vmSize"].string,
      .spec.devices[0].attributes["azure.dra.net/placementGroupId"].string
    ]
  | @tsv'
```

预期的输出形式：

```text
<node-1>  8  Standard_ND96isr_H100_v5  <placement-group-id>
<node-2>  8  Standard_ND96isr_H100_v5  <placement-group-id>
```

对于其他 SKU，请把声明的数量设置为 DRANET 为该 SKU 发布的 RDMA 设备数。

## 5. 创建整节点网卡声明模板 {#5-create-a-full-node-nic-claim-template}

为每种虚拟机规格创建一个模板。这个 H100 示例把全部 8 块 InfiniBand 网卡分配给一个 Pod。对于其他支持 RDMA 的 ND SKU，请修改名称、数量和虚拟机规格选择器：

```yaml
apiVersion: resource.k8s.io/v1
kind: ResourceClaimTemplate
metadata:
  name: nd-rdma-full-node-h100
  namespace: llm-d-infra
spec:
  spec:
    devices:
      requests:
        - name: rdma-nics
          exactly:
            deviceClassName: dranet.net
            count: 8
            selectors:
              - cel:
                  expression: >-
                    device.attributes["azure.dra.net"]["vmSize"] ==
                    "Standard_ND96isr_H100_v5"
```

应用它：

```bash
kubectl apply -f nd-rdma-full-node-h100.yaml
```

做部分节点的实验时，请使用较小的声明数量。部分节点的 GPU 和网卡放置需要额外验证 PCI 和 NUMA 拓扑。

## 6. 配置 llm-d 模型服务器 Pod {#6-configure-llm-d-model-server-pods}

每个整节点模型服务器 Pod 都按其 SKU 申请相应数量的 GPU 和网卡。下面的 H100 示例申请 8 块 GPU 和 8 网卡的声明，并获得 `IPC_LOCK` 能力：

```yaml
spec:
  nodeSelector:
    kubernetes.azure.com/agentpool: <node-pool-name>
  tolerations:
    - key: sku
      operator: Equal
      value: gpu
      effect: NoSchedule
  resourceClaims:
    - name: rdma-nics
      resourceClaimTemplateName: nd-rdma-full-node-h100
  containers:
    - name: modelserver
      securityContext:
        allowPrivilegeEscalation: false
        capabilities:
          add:
            - IPC_LOCK
          drop:
            - ALL
      env:
        - name: UCX_TLS
          value: rc_x,cuda_copy,cuda_ipc,self
      resources:
        requests:
          nvidia.com/gpu: 8
        limits:
          nvidia.com/gpu: 8
        claims:
          - name: rdma-nics
```

不要添加 `privileged: true`。不要显式设置 64 GiB 的内存锁定上限。经过验证的测试保持了常规的 8 MiB `RLIMIT_MEMLOCK` 值，并借助 `IPC_LOCK` 成功锁定了 64 MiB。

对于 prefill/decode 分离，请使用一个完整的 GPU 节点做 prefill，另一个完整的 GPU 节点做 decode。按所选 SKU 设置张量并行规模和资源数量。添加必需的 Pod 反亲和性，使两个引擎运行在不同的节点上。

## 7. 在部署服务技术栈之前进行验证 {#7-validate-before-you-deploy-the-serving-stack}

仅仅发布了 GPU 和 ResourceSlice 并不意味着基础设施已经就绪。请在选定的节点上运行实际的数据路径测试。

必须通过的关卡：

1. 单网卡 DRA 隔离 Pod 恰好看到一个已分配的 `uverbs` 设备。
2. 整节点声明暴露预期数量的 `uverbs` 设备。
3. 双节点 `ib_write_bw` 使用 InfiniBand RC 传输，且没有回退到 TCP。
4. NCCL 报告 DMA-BUF 和 `GDRDMA`，并以零错误值完成。
5. NIXL 选择 UCX `rc_mlx5`，并以零错误值传输 GPU 内存。
6. 整节点 NCCL 测试使用所有预期的 GPU 和 RDMA 通道。

我们在两个 `Standard_ND96isr_H100_v5` 节点上验证了这条数据路径。所有必需的测试均已通过：

| 测试 | 验证结果 |
| --- | --- |
| DRA 设备隔离 | 一个非特权 Pod 只能看到分配给它的 `uverbs` 设备 |
| 整节点 DRA 声明 | Pod 中可见 8 个 RDMA 设备 |
| 原始 InfiniBand | `ib_write_bw` 使用 RC 传输，单通道达到 375.97 Gb/s |
| NCCL | 16 块 GPU 使用全部 8 条 GDRDMA 通道，零错误值 |
| NIXL | UCX `rc_mlx5` 完成了一次经过校验的 GPU 内存传输，零错误值 |
| 跨放置组路径 | 原始 InfiniBand、NCCL 和 NIXL 在不同放置组之间均通过测试 |

## 放置指南 {#placement-guidance}

对于受支持的 GB 系列机架级 SKU，Azure 通过 Interconnect Group、Interconnect Block 以及按机架划分的互联子组，提供更细粒度的拓扑调度。当 llm-d 工作负载需要显式的机架感知放置时，请使用这一模型。对于目前的 ND 系列部署，`placementGroupId` 只是用于诊断的 VMSS 元数据，并不能证明两个节点位于同一个物理机架中。
