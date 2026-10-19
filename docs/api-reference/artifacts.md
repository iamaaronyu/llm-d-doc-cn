# 发布制品

本页列出 llm-d 的发布制品及依赖：

1. [**CRD**](#1-crds) — llm-d 使用的 Kubernetes 自定义资源定义
2. [**llm-d 路由器**](#2-llm-d-router) — 路由层的 Helm Chart 和容器镜像
3. [**模型服务器与扩展**](#3-model-servers-and-extensions) — 推理引擎镜像以及实现高级功能的扩展
4. [**成熟路径指南**](#4-well-lit-path-guides) — 针对关键用户场景的部署清单和基准测试脚本
5. [**网关方案**](#5-gateway-recipes) — 用于安装网关并将其与 llm-d 集成的可选方案
6. [**异步处理器**](#6-async-processor) — 用于基于队列的异步请求处理的 Helm Chart 和容器镜像

:::info
llm-d 采用模块化的部署模式，便于逐步采用各项功能。希望使用单一 CRD 驱动部署模式的用户，可以考虑 KServe 的 [LLMInferenceService](https://kserve.github.io/website/docs/model-serving/generative-inference/llmisvc/llmisvc-overview)。
:::


## 1. GAIE CRD {#1-crds}

llm-d 使用 Gateway API Inference Extension（GAIE）项目中定义的 API：

| CRD | 用途 | 提供方 |
|-----|----------|----------|
| [InferencePool](../api-reference/inferencepool.md) | 定义推理端点（模型服务器）资源池，并为 LLM 感知路由配置 EPP 和代理。 | `kubernetes-sigs/gateway-api-inference-extension` |
| [InferenceObjective](../api-reference/inferenceobjective.md) | 为资源池中特定模型工作负载定义性能目标（优先级、延迟）。 | `llm-d/llm-d-router` |
| [InferenceModelRewrite](../api-reference/inferencemodelrewrite.md) | 指定改写请求体中模型名称的规则，用于流量拆分和金丝雀发布。 | `llm-d/llm-d-router` |

GAIE CRD 的版本来自 [env.sh 文件](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/env.sh)。由于版本信息集中存放在各指南共用的位置，升级会很方便。

```bash
export REPO_ROOT=$(realpath $(git rev-parse --show-toplevel))
source ${REPO_ROOT}/guides/env.sh
```

清单发布在 [kubernetes-sigs/gateway-api-inference-extension/config/crd](https://github.com/kubernetes-sigs/gateway-api-inference-extension/tree/main/config/crd)，可以这样安装：

```bash
# GAIE_URL 由 ${REPO_ROOT}/guides/env.sh 中的 GAIE_VERSION 自动计算得出
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api-inference-extension/${GAIE_URL}/v1-manifests.yaml
```

## 2. llm-d 路由器 {#2-llm-d-router}

llm-d 路由器通过 Helm 部署。我们为独立模式和网关模式分别提供了 Chart：

| Chart | 版本 | OCI 仓库 | 说明 |
|-------|---------|--------------|-------------|
| **独立模式** | v0 | `oci://ghcr.io/llm-d/charts/llm-d-router-standalone` | 部署 InferencePool 和 EPP，并在 EPP Pod 中运行独立的 Sidecar 代理（默认 Envoy，也可通过 `router.proxy.proxyType=agentgateway` 使用 agentgateway） |
| **网关模式** | v0 | `oci://ghcr.io/llm-d/charts/llm-d-router-gateway` | 部署 InferencePool 和 EPP，与现有的 Kubernetes 网关（例如 Istio、AgentGateway、Envoy AI Gateway、GKE）配合使用 |

这些 Chart 目前由 Gateway API Inference Extension（GAIE）项目发布（参见[独立模式源码](https://github.com/kubernetes-sigs/gateway-api-inference-extension/tree/main/config/charts/standalone)和[网关模式源码](https://github.com/kubernetes-sigs/gateway-api-inference-extension/tree/main/config/charts/inferencepool)）。每个成熟路径指南都在 Chart 默认值之上提供 values 文件，以启用 EPP 中实现的相应功能。

:::note
在未来的版本中，Helm Chart 将改由 llm-d 项目而非 GAIE 发布。
:::


### 镜像 {#images}

llm-d 发布核心 EPP 镜像，以及用于高级功能的其他 Sidecar 镜像：

| 镜像 | 说明 | 版本 |
|-------|-------------|---------|
| `ghcr.io/llm-d/llm-d-router-endpoint-picker` | 核心 EPP 镜像 | main |
| `ghcr.io/llm-d/llm-d-router-disagg-sidecar`     | 模型服务器的可选 Sidecar，为 P/D 分离提供 KV 缓存传输 | main |


:::info
EPP 镜像在 llm-d v0.8.0 中由 `ghcr.io/llm-d/llm-d-inference-scheduler` 更名而来。旧的包已被删除，因此部署时必须同时更新镜像仓库和标签。
:::


:::note
在未来的版本中，延迟服务器镜像将从 llm-d/llm-d-latency-predictor 仓库发布。
:::


## 3. 模型服务器与扩展 {#3-model-servers-and-extensions}

llm-d 技术栈支持 vLLM 和 SGLang。

:::info
llm-d 会针对每个模型服务器的特定版本验证每个已发布的指南；不过 llm-d 路由器是通过兼容 OpenAI 的 HTTP API 和标准推理引擎指标与模型服务器通信的，因此任何较新的版本都应该可以工作。
:::


### 上游镜像 {#upstream-images}

我们建议大多数指南使用上游镜像：

| 引擎        | 镜像             | 标签       |
|---------------|-------------------|-----------|
| **vLLM**             | `docker.io/vllm/vllm-openai`            | `v0.30.0`     |
| **vLLM Omni**        | `docker.io/vllm/vllm-omni`              | `v0.28.0`     |
| **vLLM TPU**         | `docker.io/vllm/vllm-tpu`               | `v0.29.0`     |
| **vLLM XPU**         | `docker.io/vllm/vllm-openai-xpu`        | `v0.30.0`     |
| **vLLM ROCM**        | `docker.io/vllm/vllm-openai-rocm`       | `v0.30.0`     |
| **vLLM ROCM Omni**   | `docker.io/vllm/vllm-omni-rocm`         | `v0.28.0`     |
| **vLLM CPU**         | `docker.io/vllm/vllm-openai-cpu`        | `v0.30.0`     |
| **SGLang**           | `docker.io/lmsysorg/sglang`             | `v0.5.20`   |
| **TRTLLM**           | `nvcr.io/nvidia/tensorrt-llm/release`   | `1.3.0rc28`   |

### 自定义镜像 {#custom-images}

除上游镜像外，llm-d 还会构建并发布包含尚未合入 vLLM 上游功能的 vLLM 镜像，例如：

* GKE IB 网络补丁
* 支持 GB200 的 DeepEP 补丁
* AMD ROCm 上的 RIXL 支持

| 镜像 | 标签 | 加速器 | 基础操作系统 | 架构 |
|-------|-----|-------------|---------|---------------|
| `ghcr.io/llm-d/llm-d-cuda`（已弃用） | - | NVIDIA GPU | RHEL UBI9 | amd64, arm64 |
| `ghcr.io/llm-d/llm-d-aws`（已弃用）  | - | NVIDIA GPU + EFA | RHEL UBI9 | amd64, arm64 |
| `ghcr.io/llm-d/llm-d-rocm`              | `v0.10.0` | AMD ROCm | RHEL UBI9 | amd64 |
| `ghcr.io/llm-d/llm-d-xpu`               | `v0.10.0` | Intel XPU | Ubuntu 24.04 | amd64 |
| `ghcr.io/llm-d/llm-d-xpu-sglang`        | `v0.10.0` | Intel XPU | Ubuntu 24.04 | amd64 |
| `ghcr.io/llm-d/llm-d-cpu`               | `v0.10.0` | CPU | RHEL UBI9 | amd64 |

## 4. 成熟路径指南 {#4-well-lit-path-guides}

成熟路径（Well-Lit Paths）是经过测试和基准评测的部署方案，用于展示 llm-d 的关键用户场景。每个指南位于 `guides/<path>/` 下，包含：

* **EPP 配置** — 包含 EPP 配置的 Helm values 文件，配合 llm-d 路由器的 Chart 使用。
* **模型服务器清单** — 模型服务器的 Kustomize 清单，带有配合 llm-d 路由器使用所需的标签和参数。

:::info
对于部分指南，我们提供了特定云厂商的设置。这对需要 IB 和 RoCE 网络的指南尤为重要，因为这类网络尚未标准化。用户可以按需把示例适配到其他平台。
:::


更多详情请参阅[完整的指南列表](../well-lit-paths/README.md)。

## 5. 网关 {#5-gateway-recipes}

llm-d 路由器支持与 Kubernetes 网关的可选集成。以下是我们针对 `v0.10.0` 版本测试过的版本：

| 依赖 | 测试过的版本 | 备注 |
|------------|-----------------|-------|
| Gateway API CRD | `v1.5.x` | Kubernetes SIG（使用网关时必需） |
| Istio | `1.29.x` | 默认的网关提供方 |
| AgentGateway | `v1.4.x` | 新部署的首选 |

安装说明位于 [`guides/recipes/gateway/`](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/recipes/gateway)。

## 6. 异步处理器 {#6-async-processor}

[异步处理器](https://github.com/llm-d/llm-d-async)是一个可选组件，它从消息队列中拉取推理请求，根据资源池容量控制分发，并将请求转发给 llm-d 路由器。它通过 Helm 部署——参见[异步处理指南](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/batch-serving/asynchronous-processing)和[运维指南](../operations/async-processor.md)。

| Chart | 版本 | OCI 仓库 | 说明 |
|-------|---------|--------------|-------------|
| **异步处理器** | v0.10.0 | `oci://ghcr.io/llm-d/charts/llm-d-async` | 部署异步处理器及其队列后端（GCP Pub/Sub 或 Redis）、工作池和分发闸门 |

### 镜像 {#images-1}

| 镜像 | 说明 | 版本 |
|-------|-------------|---------|
| `ghcr.io/llm-d/llm-d-async` | 面向延迟不敏感流量的异步分发处理器 | v0.10.0 |

发布请求或消费结果的客户端，可以引入与镜像一同发布的 Go 模块——`github.com/llm-d/llm-d-async/api`、`/pipeline` 和 `/producer`，标签均为 `v0.10.0`。

:::note
该 Chart 在 v0.8.0 中由 `async-processor` 更名为 `llm-d-async`，Chart 版本号现在带有前导 `v`。由于 Deployment 的 selector 不可变，从已有的 `async-processor` 安装迁移时需要先卸载再重新安装，而不能使用 `helm upgrade`。
:::


## 源码仓库 {#source-repositories}

### 核心库 {#core-libraries}

| 仓库 | 语言 | 说明 |
|------------|----------|-------------|
| [llm-d/llm-d](https://github.com/llm-d/llm-d) | — | 主仓库：文档、Dockerfile、指南、CI |
| [llm-d/llm-d-router](https://github.com/llm-d/llm-d-router) | Go | EPP 路由引擎和 P/D Sidecar |
| [llm-d/llm-d-latency-predictor](https://github.com/llm-d/llm-d-latency-predictor) | Python | XGBoost 训练与预测服务器 |
| [llm-d/llm-d-kv-cache](https://github.com/llm-d/llm-d-kv-cache) | Go, Python, CPP | KV 缓存块位置索引器、文件系统卸载 |
| [llm-d/llm-d-workload-variant-autoscaler](https://github.com/llm-d/llm-d-workload-variant-autoscaler) | Go | SLO 感知的工作负载自动扩缩器 |
| [llm-d/llm-d-async](https://github.com/llm-d/llm-d-async) | Go | 面向延迟不敏感流量的异步请求处理器 |
| [llm-d/llm-d-batch-gateway](https://github.com/llm-d/llm-d-batch-gateway) | Go | 兼容 OpenAI 的 API，用于提交、跟踪和管理批量推理作业。

### 支持库 {#supporting-libraries}

| 仓库 | 语言 | 说明 |
|------------|----------|-------------|
| [llm-d/llm-d-benchmark](https://github.com/llm-d/llm-d-benchmark) | Python | 基准测试框架 |
| [llm-d/llm-d-inference-sim](https://github.com/llm-d/llm-d-inference-sim) | Go | 无需 GPU 的 vLLM 模拟器 |
