# 在 OpenShift 上运行 llm-d

本文介绍如何配置 OpenShift 集群，以使用 llm-d 运行高性能 LLM 推理。

部署说明请参阅[成熟路径指南](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/)。

## 前提条件 {#prerequisites}

llm-d 在 OpenShift 上经过以下配置的测试：

* 版本：OpenShift 4.19、4.20、4.21
* 确保集群上没有安装 ServiceMesh（OSSM）或 Istio——其中包含的 CRD 可能与 llm-d 的网关组件冲突
* 安装集群作用域的资源需要集群管理员权限

## 集群配置 {#cluster-configuration}

### GPU 配置 {#gpu-setup}

在部署 llm-d 工作负载之前，请先安装 NFD（Node Feature Discovery）和 NVIDIA GPU Operator。

[ocp-gpu-setup](https://github.com/rh-aiservices-bu/ocp-gpu-setup) 仓库提供了引导式脚本，用于在 AWS 上预配 GPU 节点并部署所需的 Operator：

```bash
git clone https://github.com/rh-aiservices-bu/ocp-gpu-setup.git
cd ocp-gpu-setup

# 配置 GPU MachineSet
./machine-set/gpu-machineset.sh

# 部署 NFD Operator
oc apply -f ./nfd

# 部署 NVIDIA GPU Operator
oc apply -f ./gpu-operator

# 应用配套的 CR
oc apply -f ./crs
```

### GPU 节点污点 {#gpu-node-taints}

OpenShift 上的 GPU 节点可能带有污点（例如 `nvidia.com/gpu: NVIDIA-L40S-PRIVATE`）。如果模型服务器 Pod 卡在 `Pending` 状态，请为部署添加相应的容忍：

```bash
oc patch deployment <deployment-name> \
  -p '{"spec":{"template":{"spec":{"tolerations":[{"key":"nvidia.com/gpu","operator":"Equal","value":"NVIDIA-L40S-PRIVATE","effect":"NoSchedule"}]}}}}'
```

## 部署 llm-d {#deploying-llm-d}

按照[成熟路径指南](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/)部署 llm-d 工作负载。每份指南在适用时都包含 OpenShift 专属步骤。

在 OpenShift 上请使用 `oc` 代替 `kubectl` 执行 CLI 命令，或通过 `oc login` 让 `kubectl` 使用你的 OpenShift 集群凭据。
