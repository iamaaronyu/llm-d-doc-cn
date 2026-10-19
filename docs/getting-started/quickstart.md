# 快速开始

本指南以简化的端到端流程，介绍如何使用 llm-d 部署**优化基线（Optimized Baseline）**配置。该配置通过负载感知和前缀缓存感知的负载均衡，降低尾延迟并提升吞吐量。

本快速开始使用**独立模式（Standalone Mode）**部署，这是上手 llm-d 最简单的方式。

## 前提条件 {#prerequisites}

- 已安装所需的客户端工具（kubectl、helm）。

- 检出 llm-d 仓库：

  ```bash
  export branch="main"
  git clone https://github.com/llm-d/llm-d.git && cd llm-d && git checkout ${branch}
  ```

- 设置以下环境变量：

  ```bash
  export REPO_ROOT=$(realpath $(git rev-parse --show-toplevel))
  source ${REPO_ROOT}/guides/env.sh
  export GUIDE_NAME="quickstart"
  export NAMESPACE=llm-d-quickstart
  ```

- 安装 Gateway API Inference Extension 的 CRD：

  ```bash
  # GAIE_URL 由 ${REPO_ROOT}/guides/env.sh 根据 GAIE_VERSION 自动计算
  kubectl apply -f https://github.com/kubernetes-sigs/gateway-api-inference-extension/${GAIE_URL}/v1-manifests.yaml
  ```

- 为安装创建目标命名空间：

  ```bash
  kubectl create namespace ${NAMESPACE} --dry-run=client -o yaml | kubectl apply -f -
  ```

- [在目标命名空间中创建 `llm-d-hf-token` Secret，其键 `HF_TOKEN` 对应一个有效的 HuggingFace token](https://github.com/llm-d/llm-d/tree/v0.10.0/helpers/hf-token.md)，用于拉取模型。
<!-- llm-d-cicd:skip start -->
  ```bash
  export HF_TOKEN=<your HuggingFace token>
  kubectl create secret generic llm-d-hf-token \
    --from-literal="HF_TOKEN=${HF_TOKEN}" \
    --namespace "${NAMESPACE}" \
    --dry-run=client -o yaml | kubectl apply -f -
  ```
<!-- llm-d-cicd:skip end -->

## 安装步骤 {#installation-instructions}

### 1. 部署 llm-d 路由器（独立模式） {#1-deploy-the-llm-d-router-standalone-mode}

llm-d 路由器负责智能负载均衡。在独立模式下，它内置了一个代理（Envoy）。

```bash
helm install ${GUIDE_NAME} \
    ${ROUTER_STANDALONE_CHART} \
    -f guides/recipes/router/base.values.yaml \
    -f guides/optimized-baseline/router/optimized-baseline.values.yaml \
    -n ${NAMESPACE} --version ${ROUTER_CHART_VERSION}
```

### 2. 部署模型服务器 {#2-deploy-the-model-server}

部署默认的模型服务器（在 NVIDIA GPU 上运行的 vLLM）。默认会部署 8 个 `Qwen/Qwen3-32B` 副本。

```bash
kubectl apply -n ${NAMESPACE} -k guides/optimized-baseline/modelserver/gpu/vllm/base/
```

:::tip
如果你使用的是其他硬件（AMD、Intel、TPU 或 CPU），可以在 `guides/optimized-baseline/modelserver/` 目录中找到对应配置。其中部分配置使用的是不同的模型（例如 CPU 上使用 `meta-llama/Llama-3.2-3B-Instruct`）；在下方的测试请求中，请使用[支持的硬件后端](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/optimized-baseline#supported-hardware-backends)中列出的模型。
:::


继续之前，等待所有模型服务器 Pod 运行并就绪：

```bash
bash ${REPO_ROOT}/guides/scripts/wait-for-pods-ready.sh -l llm-d.ai/guide=optimized-baseline -n ${NAMESPACE}
```

:::note
模型服务器 Pod 需要下载模型权重，可能需要几分钟才能启动。
:::


## 验证 {#verification}

### 1. 获取代理的 IP {#1-get-the-ip-of-the-proxy}

获取 llm-d 路由器服务的 ClusterIP：

```bash
export IP=$(kubectl get service ${GUIDE_NAME}-epp -n ${NAMESPACE} -o jsonpath='{.spec.clusterIP}')
```

### 2. 发送测试请求 {#2-send-a-test-request}

在集群内打开一个临时交互式 shell 来发送请求：

```bash
kubectl run curl-debug --rm -it \
    --image=cfmanteiga/alpine-bash-curl-jq \
    --namespace="$NAMESPACE" \
    --env="IP=$IP" \
    -- /bin/bash
```

在 shell 中发送一个 completion 请求：

```bash
curl -X POST http://${IP}/v1/completions \
    -H 'Content-Type: application/json' \
    -d '{
        "model": "Qwen/Qwen3-32B",
        "prompt": "How are you today?"
    }' | jq
```

## 清理 {#cleanup}

删除本指南创建的所有资源：

```bash
helm uninstall ${GUIDE_NAME} -n ${NAMESPACE}
kubectl delete namespace ${NAMESPACE}
```
