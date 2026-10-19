# 基础设施与环境

本节介绍 llm-d 的硬件与软件要求、集群配置、加速器规格，以及在各种物理执行环境中的平台适配。

### [Kubernetes 基础设施提供商](providers/README.md) {#kubernetes-infrastructure-providers}

各提供商专属的集群配置说明（GKE、AKS、OpenShift、Minikube、DigitalOcean）。

### [多节点服务编排](multi-node.md) {#multi-node-serving-orchestration}

使用 LeaderWorkerSet（LWS）和拓扑感知调度部署多主机推理工作负载。

### [非 Kubernetes 与裸金属部署](no-kubernetes-deployment.md) {#non-kubernetes--bare-metal-deployments}

通过基于文件的工作节点发现，在裸金属、HPC Slurm 调度器或 Ray 上运行 llm-d 路由技术栈。

### [高速节点间网络与 RDMA](rdma/README.md) {#fast-internode-networking--rdma}

编排多主机副本拓扑和 RDMA 网络结构。

### [网关与入口资源](gateway/README.md) {#gateway--ingress-resources}

配置入口控制器、Gateway API 和服务网格。

---

## llm-d 基础设施 {#llm-d-infrastructure}

llm-d 在以下配置上进行测试，支持业界领先的 AI 加速器：

* Kubernetes：1.29 或更新版本
  * 集群调度器必须支持把多个 Pod 放置在同一网络域内，以运行多主机推理
  * 推荐使用 Kubernetes v1.33.0+，以获得完整的 Sidecar init 容器支持（restartPolicy: Always）。如果使用 Kubernetes v1.28.x 或更低版本，由于 Sidecar 支持不完整，Pod 可能会卡在 Init:0/1 状态。
* 近几代的数据中心级加速器
  * AMD MI250X 或更新型号
  * Google TPU v5e、v6e 及更新型号
  * NVIDIA L4、A100、H100、H200、B200 及更新型号
* 高速节点间网络
  * 加速器之间
    * AMD Infinity Fabric、InfiniBand 网卡
    * Google TPU ICI
    * NVIDIA NVLink、InfiniBand 或 RoCE 网卡
  * 主机之间及南北向流量
    * 高速（总吞吐 100Gbps 以上）数据中心网卡
* 主机
  * 每台机器 80 个以上 x86 或 ARM 核心
  * 500GiB 或以上内存
  * PCIe 5 或更新

较旧的配置也可能可以工作，尤其是稍旧一些的加速器，但测试只能尽力而为。

## （可选）vLLM 容器镜像 {#optional-vllm-container-image}

llm-d 提供基于 [vLLM 上游](https://github.com/vllm-project/vllm/tree/main/docker)构建的容器镜像，这些镜像已在受支持的硬件上测试，并安装了所有必需的优化库。如果要使用自己的镜像构建和部署，应集成以下组件：

* 通用
  * vLLM：0.10.0 或更新版本
  * NIXL：0.5.0 或更新版本
  * UCX：0.19.0 或更新版本
* NVIDIA 专用
  * NVSHMEM：3.3.9 或更新版本

llm-d 指南要求 vLLM 镜像遵循一系列约定：

* 通用
  * 至少提供一个与 vLLM 兼容的 Python 版本（3.9 至 3.12）
    * 建议至少使用 3.10+
  * 必须打包所需的系统库
    * `LD_LIBRARY_PATH` 必须包含 vLLM 运行所需的所有系统库
  * `PATH` 必须包含 vLLM 可执行文件，并且直接调用 `vllm` 时应在正确的 Python 环境（即虚拟环境）中启动
  * 镜像的默认命令（如未指定则为 entrypoint）应以服务配置启动 vLLM，并接受额外的参数
    * 带有 `args` 的 Pod 应把所有参数传给 vLLM
    * 带有 `command: ["vllm", "serve"]` 的 Pod 应覆盖镜像的任何默认值
* 缓存
  * 把默认的编译缓存目录环境变量设置在共享根路径 `/tmp/cache/compile/<NAME>` 之下
    * 例如设置 `VLLM_CACHE_ROOT=/tmp/cache/compile/vllm`，确保 vLLM 编译到临时目录
    * 未来版本的 vLLM 将建议把一个 Pod 卷挂载到 `/tmp/cache`，以减轻部分缓存在重启时的损失。
  * 不要硬编码模型缓存目录和模型缓存相关的环境变量
    * 未来版本的 llm-d 将提供 vLLM 模型加载的约定
* 硬件
  * 遵循你所用硬件生态的最佳实践，包括：
    * 期望从标准的主机路径挂载特定于硬件的驱动和库，并以参数值的形式提供
    * 对内核进行预先（AOT）编译
  * NVIDIA 专用
    * `LD_LIBRARY_PATH` 包含 `/usr/local/nvidia/lib64` 目录，以便 Kubernetes GPU Operator 注入合适的驱动

## 在成熟的基础设施提供商上安装 {#installing-on-a-well-lit-infrastructure-provider}

以下文档介绍了 llm-d 在各集群基础设施提供商上经过测试的配置，以及会影响模型服务器访问加速器方式的具体部署设置。

* [Azure Kubernetes Service（AKS）](providers/aks/README.md)
* [DigitalOcean Kubernetes（DOKS）](providers/digitalocean/README.md)
* [Google Kubernetes Engine（GKE）](providers/gke/README.md)
* [OpenShift（OCP）](providers/openshift/README.md)、[AWS 上的 OpenShift](providers/openshift-aws/README.md)
* [minikube](providers/minikube/README.md)，用于单主机开发

这些提供商配置会定期测试。

在继续之前，请按照各提供商的专属文档，确保 Kubernetes 集群和硬件配置正确。

## 其他提供商 {#other-providers}

要把新的基础设施提供商加入成熟路径，我们需要以下支持：

* 说明如何配置该平台以支持一个或多个[成熟路径指南](https://github.com/llm-d/llm-d/tree/v0.10.0/guides#well-lit-path-guides)的文档
* 向指南贡献相应的配置，以处理该提供商特有的差异
* 一个用于验证受支持指南的自动化测试环境
* 至少一名有文档记录的平台维护者，负责响应 GitHub issue，并能在 llm-d Slack 频道 `#sig-installation` 中参与定期讨论。
