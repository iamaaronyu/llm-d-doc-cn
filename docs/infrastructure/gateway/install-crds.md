# 安装 Gateway API CRD

部署任何 Gateway 提供方之前，必须先安装 Gateway API 和 Gateway API Inference Extension 的 CRD。

:::note
在 GKE `1.34.0-gke.1626000` 或更新版本上，GKE 会自动安装 Gateway API 和 Gateway API Inference Extension 的所有 GA CRD。如果你使用的 GKE 是该版本或更新版本，可以跳过下面的安装步骤。
:::


## 方式一：使用安装脚本 {#option-1-using-the-installation-script}

安装 CRD 最快的方式是使用提供的脚本：

```bash
bash guides/recipes/gateway/install-gateway-crds.sh
```

该脚本会同时安装 Gateway API 和 Gateway API Inference Extension 的 CRD。

## 方式二：手动安装 {#option-2-manual-installation}

如果你更倾向于手动安装，或者需要自定义版本：

```bash
GATEWAY_API_VERSION=v1.5.1
GAIE_VERSION=v1.5.0
GATEWAY_API_INSTALL_URL=https://github.com/kubernetes-sigs/gateway-api/releases/download/${GATEWAY_API_VERSION}/standard-install.yaml
GAIE_INSTALL_URL=https://github.com/kubernetes-sigs/gateway-api-inference-extension/releases/download/${GAIE_VERSION}/v1-manifests.yaml

kubectl apply -f "${GATEWAY_API_INSTALL_URL}"
kubectl apply -f "${GAIE_INSTALL_URL}"
```

## 验证 {#verification}

确认这些 API 可用：

```bash
kubectl api-resources --api-group=gateway.networking.k8s.io
kubectl api-resources --api-group=inference.networking.k8s.io
```

你应该能看到 `gateways`、`httproutes` 和 `inferencepools` 等资源。

## 卸载 Gateway API CRD {#uninstalling-gateway-api-crds}

### 方式一：使用安装脚本 {#option-1-using-the-installation-script-1}

卸载 CRD 最快的方式是使用提供的脚本：

```bash
bash guides/recipes/gateway/install-gateway-crds.sh delete
```

### 方式二：手动卸载 {#option-2-manual-uninstall}

如果你更倾向于手动卸载：

```bash
GATEWAY_API_VERSION=v1.5.1
GAIE_VERSION=v1.5.0

kubectl delete -f https://github.com/kubernetes-sigs/gateway-api/releases/download/${GATEWAY_API_VERSION}/standard-install.yaml
kubectl delete -f https://github.com/kubernetes-sigs/gateway-api-inference-extension/releases/download/${GAIE_VERSION}/v1-manifests.yaml
```
