# 非 Kubernetes 部署

llm-d 的参考部署运行在 Kubernetes 上——工作节点由 Kubernetes `Deployment` 管理，EPP 通过 `InferencePool` 发现它们，平台负责网络和生命周期。然而，许多环境并没有 Kubernetes 控制面：Slurm 或 LSF 等 HPC 调度器会动态启动工作节点，基于 Ray 的技术栈以 actor 形式运行工作节点，裸金属推理集群不使用 K8s，而一台带有几块 GPU 的工作站通常就足以用于开发。

非 Kubernetes 路径直接以主机进程或容器的形式运行同一套路由技术栈——llm-d EPP、Envoy 以及一个或多个模型服务器。EPP 通过 [file-discovery 插件][filediscovery-plugin]从磁盘上的 YAML 文件获取端点清单，而不是通过 Kubernetes API 监视 `InferencePool`；其他一切（EPP 插件集、打分、Envoy ext_proc、vLLM 参数）都保持不变。

:::info
没有 Kubernetes 时，llm-d 技术栈中的部分组件不在支持范围内：由 `InferenceObjective` 驱动的流量控制、`InferenceModelRewrite` 模型名称重写器，以及基于 `PodMonitor` 的 Prometheus 发现。打分、前缀缓存亲和性、基于饱和度的准入以及 `--metrics-port` 上的 Prometheus 指标都可以正常工作；完整列表请参阅[功能对等说明][blog-parity]。
:::


## 部署 {#deploy}

清单文件和分步部署说明请参阅[非 Kubernetes 部署指南](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/no-kubernetes-deployment)。

## 架构 {#architecture}

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)">
    <img src="/img/versioned/0.10/assets/no-kubernetes-deployment.svg" alt="非 Kubernetes 部署">
  </picture>
</p>

流量的流转方式与优化基线路径相同：

```
客户端 -> Envoy 监听器 :8081
       -> ext_proc gRPC :9002（EPP 选择端点并设置请求头）
       -> ORIGINAL_DST 集群
       -> 从 EPP 响应中读取 x-gateway-destination-endpoint
       -> EPP 所选 vLLM 工作节点的 <address>:<port>
```

EPP 的数据存储完全由 `endpoints.yaml` 填充。设置 `watchFile: true` 后，每次对该文件进行原子性重写都会触发热加载——增加、移除工作节点或修改其标签都无需重启 EPP 即可生效。插件集、权重和调度 Profile 与[优化基线](../well-lit-paths/foundations/optimized-baseline.md)一致，因此路由行为与基于 Kubernetes 的部署完全相同。

## 延伸阅读 {#further-reading}

- [`file-discovery` 插件源码][filediscovery-plugin]
- [“没有 Kubernetes？没问题”][blog]——设计的完整背景

[filediscovery-plugin]: https://github.com/llm-d/llm-d-router/blob/v0.11.0/pkg/epp/framework/plugins/datalayer/discovery/file/plugin.go
[blog]: https://llm-d.ai/blog/running-llm-d-without-kubernetes
[blog-parity]: https://llm-d.ai/blog/running-llm-d-without-kubernetes#parity-with-the-kubernetes-native-llm-d-deployment
