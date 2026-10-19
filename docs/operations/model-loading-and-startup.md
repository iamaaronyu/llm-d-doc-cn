# 模型加载与启动加速

本指南用于优化现有 llm-d 部署中的模型启动时间，涵盖模型文件获取、权重加载、编译以及其他引擎初始化环节。

文件缓存可以减少重复下载，JIT 缓存可以复用已编译的产物，ModelExpress 可以加速权重传输；下文会注明各后端特有的设置。这些缓存与 [KV 缓存管理](../architecture/advanced/kv-management/README.md)是两回事。

## 从 Hugging Face Hub 加载 {#loading-from-hugging-face-hub}

在 `modelserver` 中，向 [`vllm serve`](https://docs.vllm.ai/en/latest/configuration/engine_args/) 传入 Hub 模型 ID（例如 `Qwen/Qwen3-0.6B`）。对于 [SGLang](https://docs.sglang.ai/advanced_features/server_arguments.html)，请改用 `--model-path`。两者都支持用 `--served-model-name` 指定 API 中的模型名称。请把 `--revision` 固定到某个提交 SHA；对于 vLLM，在适用时还应固定 `--tokenizer-revision` 和 `--code-revision`。

受限（gated）或私有模型需要[访问权限和 token](https://github.com/llm-d/llm-d/tree/v0.10.0/helpers/hf-token.md)。对于公开模型，可以删除对 `llm-d-hf-token` Secret 的引用，或将其标记为可选：

```yaml
- name: HF_TOKEN
  valueFrom:
    secretKeyRef:
      name: llm-d-hf-token
      key: HF_TOKEN
      optional: true
```

把 Secret 标记为可选并不能绕过授权。不要把 token 写进清单文件。

## 模型缓存与内部仓库 {#model-caches-and-internal-registries}

使用节点本地存储或 PVC 来复用模型文件，使用内部仓库作为自托管的模型来源。仅凭其中任何一项都不能使部署成为完全离线（air-gapped）的环境。

### 节点本地缓存 {#node-local-cache}

在节点提供了合适的本地存储时，把一个主机目录挂载到 Hugging Face 缓存路径：

```yaml
containers:
  - name: modelserver
    env:
      - name: HF_HOME
        value: /root/.cache/huggingface
    volumeMounts:
      - name: huggingface-cache
        mountPath: /root/.cache/huggingface
volumes:
  - name: huggingface-cache
    hostPath:
      path: /var/cache/huggingface
      type: DirectoryOrCreate
```

这样可以在同一节点上复用下载结果，但无法跨节点复用，节点被替换后也无法复用。

:::note
`/var/cache/huggingface` 只是一个示例主机路径。请选择符合节点磁盘分配和存储策略、并满足集群安全策略的目录。
:::


### PVC 缓存 {#pvc-cache}

使用 [model-cache 组件](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/recipes/modelserver/components/model-cache/kustomization.yaml)，在 RWX PVC 上持久化并共享 Hugging Face 的下载内容。它会修补每个 `Deployment` 的第一个容器；请在该容器为 `modelserver` 的模型服务器覆盖层中使用它。请在仓库根目录下，结合你所用指南的 `NAMESPACE`、模型配置和凭据运行以下步骤。

1. **创建 `model-pvc`。**根据容量和支持 RWX 的 StorageClass 调整[示例](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/recipes/modelserver/components/model-cache/model-cache-pvc.yaml)：

   ```bash
   kubectl -n "${NAMESPACE}" apply \
     -f guides/recipes/modelserver/components/model-cache/model-cache-pvc.yaml
   ```

2. **把组件加入现有的覆盖层。**在其 `kustomization.yaml` 中，把 [model-cache 组件](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/recipes/modelserver/components/model-cache/kustomization.yaml)加入 `components`，使用该组件目录相对于你的覆盖层目录的路径。保留现有的资源、组件和补丁。[AMD CI 覆盖层](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/optimized-baseline/modelserver/amd/vllm/amd-ci/kustomization.yaml)可作为引入组件的参考，但它并不是本示例的部署目标。

3. **渲染并验证。**把 `MODEL_SERVER_OVERLAY` 设置为你修改后的覆盖层目录：

   ```bash
   kubectl kustomize "${MODEL_SERVER_OVERLAY}"
   ```

   检查 `modelserver` 中是否有 `HF_HOME=/model-cache`，以及由 `model-pvc` 支撑的 `/model-cache` 挂载，且没有重复条目。保留远程模型 ID；按照指南部署后，验证缓存的写入权限以及[推理请求](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/optimized-baseline#verification)。

### 使用 MatrixHub 自托管仓库 {#self-hosted-registry-with-matrixhub}

[MatrixHub](https://github.com/matrixhub-ai/matrixhub) 通过一个自托管的、与 Hugging Face 兼容的 API 提供缓存的模型权重文件。请先[预缓存模型](https://matrixhub.ai/docs/guides/mirror-from-huggingface/)，然后使用其仓库 ID。

按照 [vLLM 的 MatrixHub 文档](https://docs.vllm.ai/en/latest/models/supported_models/#matrixhub)，在 `modelserver.env` 中把 `HF_ENDPOINT` 设置为模型服务器 Pod 能够访问的仓库地址：

```yaml
- name: HF_ENDPOINT
  value: "http://<matrixhub-host>:9527"
```

本示例假设在受信任的网络中进行匿名访问。请删除继承下来的 `HF_TOKEN` Secret 引用，并确保不会使用任何已保存或显式提供的 Hugging Face 凭据。

## 加速模型启动 {#accelerating-model-startup}

### 复用编译缓存 {#compilation-cache-reuse}

vLLM 的编译缓存（JIT 缓存）存储的是编译产物而不是模型权重，用于减少后续启动时的编译开销。请把 `VLLM_CACHE_ROOT` 指向一个持久、可写的目录。Wide EP 的[缓存配置](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/wide-ep/modelserver/gpu/vllm-deepseek-r1-0528/base/disaggregatedset.yaml)把它放在 `/var/cache/vllm` 下；[CoreWeave 覆盖层](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/wide-ep/modelserver/gpu/vllm-deepseek-r1-0528/coreweave/kustomization.yaml)则使用节点本地的 `hostPath` 存储来持久化该挂载。

缓存为空时，第一次启动仍然会进行编译并填充缓存；之后兼容的启动可以复用这些结果。配置或代码的变化可能触发重新编译，因此持久化并不能保证启动时完全无需编译。节点本地缓存只能在该节点上复用。参见 [vLLM 的编译缓存文档](https://docs.vllm.ai/en/latest/design/torch_compile/#compilation-cache)。

### ModelExpress

[ModelExpress](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/modelexpress-p2p) 使用 vLLM 的 `--load-format=mx`，通过 NIXL/RDMA 从种子副本传输权重。种子副本需要一个检查点来源；请使用该指南中的镜像，并遵循其对版本、CRD、GPU 和网络结构的要求。

该指南还涵盖了[检查点预置](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/modelexpress-p2p/measuring-storage-paths.md#1-prewarm-the-checkpoint-onto-nfs-once)（普通文件，而不是 `HF_HOME` 缓存）、[通过 P2P 传输或共享 RWX PVC 分发编译缓存](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/modelexpress-p2p/compile-cache.md)，以及使用 [NFS 或本地 NVMe 上的 fastsafetensors](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/modelexpress-p2p/measuring-storage-paths.md) 等基于存储的 P2P 替代方案；请遵循每条路径的前提条件。

关于进程复用，请参阅 [FMA 休眠/唤醒](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/fast-model-actuation-base)，并遵循该指南的前提条件。

### Pod 快照 {#pod-snapshots}

[Pod 快照](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/pod-snapshot)会捕获模型服务器初始化完成后的状态，使后续的 Pod 可以直接恢复该状态，而不必重复下载模型和初始化引擎。所链接的指南介绍了在 GKE 上使用 GKE Pod Snapshots、GKE Sandbox（gVisor）和 Google Cloud Storage 运行单 GPU vLLM 的做法。请遵循该指南的前提条件，并等待第一个快照就绪后再进行扩容。

## Hugging Face 访问受限时 {#when-hugging-face-access-is-limited}

如果 Pod 无法可靠地访问 Hub 或其制品端点，请使用可以访问的替代平台，例如 ModelScope。它同样需要网络访问。

### 使用 ModelScope {#using-modelscope}

对于 [vLLM](https://docs.vllm.ai/en/latest/models/supported_models/#modelscope)，设置 `VLLM_USE_MODELSCOPE=True`；如果缺少 `modelscope`，请在构建镜像时用 `pip` 安装一个兼容且固定版本的 `modelscope`。请使用 ModelScope 的模型 ID、修订版本和 `MODELSCOPE_CACHE`，而不是 `HF_HOME`。对于固定的检查点，可以预先放置经过校验的文件，并使用其本地目录作为模型路径。

## 验证与故障排查 {#verification-and-troubleshooting}

查看模型服务器的启动日志，确认加载已完成。修改模型名称或路由后，请[通过 llm-d 测试一次请求](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/optimized-baseline#verification)。

在固定模型修订版本、镜像、硬件和并行配置的前提下，比较冷启动、热缓存重启和扩容的情况。记录权重加载时间、编译时间以及到所有目标 Pod 都 Ready 的总时间，并注明缓存状态以及是否计入了下载或预置的时间。比较[存储路径](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/modelexpress-p2p/measuring-storage-paths.md)时，请保持编译设置不变。

### Hugging Face 限流 {#hugging-face-rate-limiting}

在大规模发布或扩容期间，多个 Pod（包括 prefill 和 decode 副本）并发下载模型权重可能会触发 Hugging Face 限流（HTTP 429），从而延迟启动。复用[模型缓存](#model-caches-and-internal-registries)或预置模型文件可以减少并发下载；延长请求超时并不能消除限流。

### Hub 请求超时 {#hub-request-timeouts}

如果 Hub 请求超时，请在 `modelserver.env` 中调整 [Hub 超时设置](https://huggingface.co/docs/huggingface_hub/en/package_reference/environment_variables)：`HF_HUB_DOWNLOAD_TIMEOUT` 控制文件下载的响应超时，`HF_HUB_ETAG_TIMEOUT` 控制元数据请求的超时。两者单位都是秒。请根据你的网络状况调整下面的示例值：

```yaml
- name: HF_HUB_DOWNLOAD_TIMEOUT
  value: "60"
- name: HF_HUB_ETAG_TIMEOUT
  value: "60"
```

### Xet 下载失败 {#xet-download-failures}

对于 `hf-xet` 下载后端特有的失败，可以在诊断问题时尝试设置 `HF_HUB_DISABLE_XET=1`。不要默认禁用 Xet，也不要把它当作应对限流的办法。

### 启动期间容器重启 {#container-restarts-during-startup}

检查 Pod 事件和启动日志，确认导致重启的是启动探针失败，而不是进程崩溃。如果初始化仍在推进，请把 `startupProbe.failureThreshold * startupProbe.periodSeconds` 设置为能够覆盖实测最坏情况下的冷启动时间（包括下载、权重加载、编译和引擎初始化），并留出余量。

调整这些字段时，请保留现有的探针处理方式。这可以避免容器过早重启，但并不能加速启动。完整示例请参阅[探针配置指南](readiness-probes.md#recommended-probe-configuration)。

### 缓存存储错误 {#cache-storage-errors}

* [缓存空间不足](https://github.com/llm-d/llm-d/issues/857)：确认下载使用了预期的挂载。确保缓存卷有足够的空间存放完整的检查点以及临时下载文件。
* [Hugging Face 写入缓存时遇到只读文件系统](https://github.com/llm-d-incubation/llm-d-modelservice/issues/243)：可以让完整预加载的检查点保持只读，但要为下载缓存另外提供一个可写的挂载。
