# 多节点服务编排

## （可选）为多主机推理安装 LeaderWorkerSet {#optional-install-leaderworkerset-for-multi-host-inference}

LeaderWorkerSet（LWS）Kubernetes 工作负载控制器专门用于部署每个副本由多个 Pod 组成、且这些 Pod 分布在多台主机（具体是加速器节点）上的服务工作负载。llm-d 默认使用 LWS 部署多主机推理，以获得 rank 到 Pod 的映射、确保最佳加速器网络性能的拓扑感知放置，以及在节点或加速器故障时用于恢复的“全有或全无”故障与重启语义。

使用 LWS 部署 llm-d 指南时，请按照 [LWS 安装指南](https://lws.sigs.k8s.io/docs/installation/)安装推荐的 0.11.0 版本。

### 安装 LWS {#install-lws}

把 LWS 0.11.0 版本安装到 `lws-system` 命名空间：

```bash
export LWS_VERSION="0.11.0"
export LWS_NAMESPACE="lws-system"

helm install lws oci://registry.k8s.io/lws/charts/lws \
  --version "${LWS_VERSION}" \
  --namespace "${LWS_NAMESPACE}" \
  --create-namespace \
  --set enableDisaggregatedSet=true
```

:::warning
如果你曾使用 Helm 安装过 LWS 0.7.0 或更早版本，请不要直接升级到更新的版本。升级过程中 Helm 可能会删除 LWS CRD，并级联删除现有的 `LeaderWorkerSet` 资源；参见 [kubernetes-sigs/lws#880](https://github.com/kubernetes-sigs/lws/issues/880)。
:::


### 卸载 LWS {#uninstall-lws}

卸载 LWS：

```bash
export LWS_NAMESPACE="lws-system"

helm uninstall lws --namespace "${LWS_NAMESPACE}"
```

## （可选）为多主机推理的拓扑感知调度安装 Kueue 和 Kueue Populator {#optional-install-kueue-and-kueue-populator-for-topology-aware-scheduling-for-multi-host-inference}

[Kueue](https://github.com/kubernetes-sigs/kueue/tree/main) 是一个用于作业排队的 Kubernetes 控制器。与 [Kueue-Populator](https://github.com/kubernetes-sigs/kueue/tree/main/cmd/experimental/kueue-populator) 结合使用时，它可以调度多主机推理工作负载，以获得最佳的加速器网络性能。

使用 LWS 部署 llm-d 指南时，请参照 [TAS + LWS 用户指南](https://lws.sigs.k8s.io/docs/examples/tas/)配置拓扑感知调度。
