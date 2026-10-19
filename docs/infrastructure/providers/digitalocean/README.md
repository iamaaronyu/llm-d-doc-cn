# 在 DigitalOcean Kubernetes Service（DOKS）上运行 llm-d

本文介绍如何配置 DOKS 集群，以使用 llm-d 运行高性能 LLM 推理。

部署说明请参阅[成熟路径指南](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/)。

## 前提条件 {#prerequisites}

llm-d 在 DOKS 上经过以下配置的测试：

* GPU 类型：NVIDIA H100、NVIDIA RTX 6000 Ada、NVIDIA RTX 4000 Ada、NVIDIA L40S
* 版本：DOKS 1.33.1-do.3
* 网络：VPC 原生集群（必需）

## 集群配置 {#cluster-configuration}

DOKS 集群应按以下设置配置：

* [启用 GPU 的节点池](https://docs.digitalocean.com/products/kubernetes/details/supported-gpus/)，至少包含 2 个 GPU 节点
* [VPC 原生网络](https://docs.digitalocean.com/products/kubernetes/details/features/#vpc-native-networking)（新集群的默认设置）
* [已配置 kubectl](https://docs.digitalocean.com/products/kubernetes/how-to/connect-to-cluster/) 以访问集群

### GPU 驱动管理 {#gpu-driver-management}

DigitalOcean 会在 DOKS 集群上自动安装和管理 GPU 驱动：

* **NVIDIA 设备插件**：自动安装，用于 GPU 发现和调度
* **驱动更新**：随集群更新一同管理
* **GPU 监控**：通过 DCGM Exporter 内置指标采集

验证 GPU 是否已自动配置：

```bash
kubectl get pods -n nvidia-device-plugin-system
kubectl get nodes -o custom-columns="NAME:.metadata.name,GPU:.status.allocatable.nvidia\.com/gpu"
```

### GPU 节点污点 {#gpu-node-taints}

DOKS 的 GPU 节点使用污点来阻止非 GPU 工作负载被调度上去。请为模型服务器部署添加以下容忍：

```yaml
tolerations:
- key: "nvidia.com/gpu"
  operator: "Exists"
  effect: "NoSchedule"
```

## 部署 llm-d {#deploying-llm-d}

按照[成熟路径指南](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/)部署 llm-d 工作负载。每份指南在适用时都包含 DigitalOcean 专属步骤。

## 故障排查 {#troubleshooting}

### LoadBalancer 处于 Pending 或出现 API 错误 {#loadbalancer-pending-or-api-errors}

**错误**：LoadBalancer 卡在 `<pending>` 状态并伴有 API 错误

**原因**：DigitalOcean API 限流，或存在并发的 LoadBalancer 操作

**解决方法**：

```bash
# 检查 LoadBalancer 状态
kubectl describe svc <service-name> -n <namespace>

# 等待 API 操作完成（通常需要 2-3 分钟）
# 按顺序部署可以避免冲突
```

### Pod 无法调度到 GPU 节点 {#pods-fail-to-schedule-on-gpu-nodes}

**错误**：`untolerated taint {nvidia.com/gpu}`

**原因**：DOKS 的 GPU 节点自动带有污点，以阻止非 GPU 工作负载

**解决方法**：确保部署中包含 `nvidia.com/gpu` 容忍。验证其是否已生效：

```bash
kubectl describe pod <pod-name> -n <namespace> | grep Tolerations
# 应显示：nvidia.com/gpu:NoSchedule op=Exists
```

### Gateway 未就绪（Not Programmed） {#gateway-not-programmed}

**错误**：Gateway 显示 `PROGRAMMED: False`

**解决方法**：确认 Istio 正在运行，并且 LoadBalancer IP 已分配：

```bash
kubectl get pods -n istio-system
kubectl get gateway -n <namespace>
```
