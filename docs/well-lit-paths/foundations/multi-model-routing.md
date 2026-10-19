# 多模型路由

组织经常需要在单个 API 端点后提供多个大语言模型。例如，聊天机器人应用可能使用 Qwen 模型处理对话任务，而推荐系统使用 DeepSeek 进行复杂推理。每个基础模型还可能有多个低秩适配（LoRA）微调变体，分别服务不同的场景。

当这些模型共享同一个 API 路径（`/v1/chat/completions`）时，传统的基于路径的路由无法区分它们。**推理载荷处理器（Inference Payload Processor，IPP）**通过从请求体中提取模型名称并路由到相应的 InferencePool 来解决这个问题。

:::note
此能力需要部署 IPP。对于只提供单个模型的较简单部署，请参阅[优化基线](optimized-baseline.md)指南。
:::


## 部署 {#deploy}

清单文件和分步部署说明请参阅[多模型路由指南](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/multi-model-routing)。

## 架构 {#architecture}

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)">
    <img src="/img/versioned/0.10/assets/multi-pool-routing.svg" alt="多模型路由架构">
  </picture>
</p>

该部署会创建多个 `InferencePool`，每个提供不同的基础模型：

* 每个 **InferencePool** 提供一个基础模型及其 LoRA 适配器。
* **IPP** 从请求体中提取模型名称，并将其映射到基础模型。
* **HTTPRoute** 根据 `X-Gateway-Base-Model-Name` 请求头进行匹配，路由到正确的资源池。
* **EPP** 在每个资源池内选择最优端点。

在标准请求流程中：

* 请求到达代理，请求体中包含 `{"model": "food-review-1"}`
* 代理通过 ext-proc 调用 IPP
* IPP 查找 `food-review-1` → 基础模型 `Qwen/Qwen3-32B`
* IPP 设置请求头 `X-Gateway-Base-Model-Name: Qwen/Qwen3-32B`
* 代理匹配 HTTPRoute 并路由到 `qwen-pool`
* EPP 选择端点，并保留原始模型名称
* 模型服务器加载 `food-review-1` LoRA 适配器

## 延伸阅读 {#further-reading}

推理载荷处理器的更多细节请参阅 [IPP 架构](../../architecture/advanced/inference-payload-processing/README.md)。
