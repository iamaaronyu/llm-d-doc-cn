# 基于预测延迟的调度

llm-d 的[优化基线指南](./optimized-baseline.md)利用负载信号和前缀缓存亲和性来调度请求，并通过启发式规则把这些信号组合起来。

本路径面向希望采用基于预测延迟进行调度的运维人员——它使用在线训练的 XGBoost 模型来做调度决策。该策略适用于以下情况：

- 你的工作负载**提示词和补全长度差异很大**，仅凭队列深度难以准确反映真实负载。
- 你的客户端可以为**每个请求表达延迟 SLO**（交互式或批处理），并且你希望由网关来保障它们。
- 随着流量变化，在缓存亲和性与负载之间手动调整静态权重已变得**脆弱**。

:::note
当资源池是**异构**的时候，预测延迟并不适用——同一资源池中混用不同 GPU 类型、模型变体（例如 prefill 与 decode）或服务配置，会导致预测不准确，因为预测器假定所有 Pod 形态一致。
:::


## 部署 {#deploy}

清单文件和分步部署说明请参阅[预测延迟指南](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/predicted-latency-routing)。

## 架构 {#architecture}

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)">
    <img src="/img/versioned/0.10/assets/latency-predictor.svg" alt="延迟预测器">
  </picture>
</p>

该部署会运行一个带有预测延迟 Sidecar 容器的 EPP：

- **训练服务器（Training Server）**——基于观测到的流量训练 XGBoost 模型，用于预测 TPOT 和 TTFT
- **预测服务器（Prediction Servers）**——基于服务器当前状态预测请求的 TPOT 和 TTFT

在标准请求流程中：

- 请求到达代理，代理将请求转发给 EPP
- EPP 查询预测服务器
- EPP（使用 `latency-scorer`）根据预测结果选出最优端点
- 代理将请求转发到 vLLM 端点
- vLLM 端点处理请求，并将响应返回给代理
- 代理把结果发送给训练服务器，训练服务器使用这些样本更新模型

## 延伸阅读 {#further-reading}

- [延迟预测器架构](../../architecture/advanced/latency-predictor.md)——插件流水线、机器学习模型、扩展特性和指标参考。
- [llm-d/llm-d-latency-predictor](https://github.com/llm-d/llm-d-latency-predictor)——训练和预测服务器 Python 代码的源码仓库。
- [LLM 的基于预测延迟调度（博客）](https://llm-d.ai/blog/predicted-latency-based-scheduling-for-llms)——设计思路和基准测试结果。
