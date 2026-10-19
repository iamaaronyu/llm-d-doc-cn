# 在 AWS 上的 Red Hat OpenShift 中运行 llm-d

本文是一份参考指南，指引你查阅 Red Hat、AWS 以及 NVIDIA 的官方文档，以搭建支持 NVIDIA GPU 的 Red Hat OpenShift Service on AWS（ROSA）集群。

## 前提条件 {#prerequisites}

开始之前，请确保满足 ROSA 官方文档中列出的前提条件：

- 一个具备 ROSA 所需权限的 AWS 账号。
- 一个 Red Hat 账号，并能访问 Red Hat OpenShift Cluster Manager。
- 所需的工具（如 rosa CLI），并熟悉 ROSA 的相关概念。

详细的前提条件请参阅 ROSA 官方文档：
[https://docs.aws.amazon.com/rosa/latest/userguide/prerequisites.html](https://docs.aws.amazon.com/rosa/latest/userguide/prerequisites.html)

## 第 1 步：创建 Red Hat OpenShift Service on AWS（ROSA）集群 {#step-1-create-a-red-hat-openshift-service-on-aws-rosa-cluster}

创建 ROSA 集群的主要方式是通过 Red Hat OpenShift Cluster Manager，或使用 ROSA CLI。

关于创建 ROSA 集群的详细说明，请参阅官方文档：

- **创建 ROSA 集群：**[https://docs.aws.amazon.com/rosa/latest/userguide/create-cluster.html](https://docs.aws.amazon.com/rosa/latest/userguide/create-cluster.html)
- **ROSA 入门：**[https://docs.aws.amazon.com/rosa/latest/userguide/getting-started.html](https://docs.aws.amazon.com/rosa/latest/userguide/getting-started.html)

## 第 2 步：添加使用 NVIDIA GPU 实例的 Machineset {#step-2-add-a-machineset-with-nvidia-gpu-instances}

要为 ROSA 集群添加具备 GPU 能力的工作节点，需要创建一个新的 machineset，并将其配置为使用包含 NVIDIA GPU 的 AWS 实例类型。这一步在 ROSA 集群预配完成后，通过 OpenShift 控制台或 oc CLI 完成。

在官方文档中了解如何管理 machineset 并为特定实例类型进行配置：

- **在 OpenShift 中管理 machineset（适用于 ROSA 工作节点）：**[https://docs.openshift.com/container-platform/latest/machine_management/creating-machinesets.html](https://docs.openshift.com/container-platform/latest/machine_management/creating-machinesets.html)
- **添加特定实例类型的 machineset（参考 AWS GPU 实例）：**查阅 AWS 文档了解可用的 GPU 实例类型（例如 P、G 和 Inf 实例），并参照 OpenShift machineset 文档进行相应配置。[https://aws.amazon.com/ec2/instance-types/](https://aws.amazon.com/ec2/instance-types/)

## 第 3 步：通过 NFD 和 GPU Operator 在 OpenShift 上启用 GPU 支持 {#step-3-enable-gpu-support-on-openshift-with-the-nfd-and-gpu-operators}

要在带 GPU 的节点上启用 GPU 加速，需要安装并配置 Node Feature Discovery（NFD）Operator 和 NVIDIA GPU Operator。NVIDIA 文档提供了在 OpenShift 上完成这一过程的完整步骤。

关于安装和配置这两个 Operator 的详细说明，请参阅 NVIDIA 文档：

- **在 OpenShift 上启用 GPU 支持（涵盖 NFD 和 GPU Operator 的安装）：**[https://docs.nvidia.com/datacenter/cloud-native/openshift/latest/steps-overview.html](https://docs.nvidia.com/datacenter/cloud-native/openshift/latest/steps-overview.html)

## 后续步骤 {#next-steps}

Operator 安装和配置完成后，就可以按照 llm-d 快速开始部署 llm-d 了。

更多信息请尝试[成熟路径指南](../../../well-lit-paths/README.md)。
