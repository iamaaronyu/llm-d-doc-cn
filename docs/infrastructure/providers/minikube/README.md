# 在 minikube 上运行 llm-d

## 前提条件 {#prerequisites}

### 平台配置 {#platform-setup}

最低可在 ec2 实例类型 [g6e.12xlarge](https://aws.amazon.com/ec2/instance-types/g6e/)（4 块 48GB 的 L40S，默认只使用其中 2 块）上运行，用于推理将被启动的模型 meta-llama/Llama-3.2-3B-Instruct。

请确认已为你选择的运行时正确安装了容器工具包。

```bash
# Podman
podman run --rm --security-opt=label=disable --device=nvidia.com/gpu=all ubuntu nvidia-smi
# Docker
sudo docker run --rm --runtime=nvidia --gpus all ubuntu nvidia-smi
```

## 安装 llm-d-infra {#llm-d-infra-installation}

待补充（TBD）
