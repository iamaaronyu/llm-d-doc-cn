# EPP gRPC API 参考

本文列出[端点选择器（EPP）](../architecture/core/router/epp)为推理流量支持的 gRPC API。gRPC 请求以 HTTP/2（H2C）流量的形式流经网关，EPP 解码 gRPC 帧和 protobuf 载荷，以进行前缀缓存感知路由、插件决策和响应用量跟踪。

与 HTTP API 不同，gRPC 解析默认不启用：必须在 [EndpointPickerConfig](endpointpickerconfig.md) 中配置相应的解析器插件。

## 支持的 gRPC API {#supported-grpc-apis}

| gRPC 方法 | 来源 | 解析器插件 | 是否支持 |
| --- | --- | --- | --- |
| `vllm.grpc.engine.VllmEngine/Generate` | vLLM gRPC 引擎 API | `vllmgrpc-parser` | ✅ |
| `vllm.grpc.engine.VllmEngine/Embed` | vLLM gRPC 引擎 API | `vllmgrpc-parser` | ✅ |

目前 `Generate` 的 gRPC API 只输出 token：响应中携带的是 token ID（`chunk.token_ids`、`complete.output_ids`），而不是解码后的文本，客户端需要自行反分词（detokenize）。

## 解析器配置 {#parser-configuration}

解析器通过 EndpointPickerConfig 的 `requestHandler.parsers` 部分进行配置。先在 `plugins` 中实例化解析器插件，再按名称引用它：

```yaml
apiVersion: llm-d.ai/v1alpha1
kind: EndpointPickerConfig
plugins:
- name: maxScore
  type: max-score-picker
- name: vllmgrpcParser
  type: vllmgrpc-parser
schedulingProfiles:
  # ... 为简洁起见省略 ...
requestHandler:
  parsers:
  - pluginRef: vllmgrpcParser
```

## InferencePool 配置 {#inferencepool-configuration}

gRPC 需要端到端的 HTTP/2。为了让网关以明文 HTTP/2（h2c）连接模型服务器 Pod，`InferencePool` 必须设置 `appProtocol: kubernetes.io/h2c`。

```yaml
apiVersion: inference.networking.k8s.io/v1
kind: InferencePool
metadata:
  name: vllm-grpc-qwen3-32b
spec:
  targetPorts:
  - number: 8000
  appProtocol: kubernetes.io/h2c
  selector:
    matchLabels:
      app: vllm-grpc-qwen3-32b
  endpointPickerRef:
    name: vllm-grpc-qwen3-32b-epp
    port:
      number: 9002
```

使用 [llm-d-router Helm Chart](https://github.com/llm-d/llm-d-router/tree/v0.11.0/config/charts) 部署时，设置 `router.modelServers.protocol=grpc` 即可自动完成这一配置。

---

## 请求示例 {#request-examples}

下面的示例使用 [grpcurl](https://github.com/fullstorydev/grpcurl)，代理端点为 `${IP}`（按相应指南的验证步骤设置）。示例需要 [`vllm_engine.proto`](https://github.com/llm-d/llm-d-router/blob/v0.11.0/pkg/epp/framework/plugins/requesthandling/parsers/vllmgrpc/api/proto/vllm_engine.proto) 定义文件，以及一个暴露 vLLM gRPC 引擎 API 的模型服务器。

### vLLM `VllmEngine/Generate`

请求（文本输入；也可以通过 `tokenized` 字段传入预先分词的输入）：

```bash
grpcurl -plaintext -proto vllm_engine.proto \
    -d '{
        "request_id": "req-1",
        "text": "Hello",
        "sampling_params": {"max_tokens": 10}
    }' \
    ${IP}:80 vllm.grpc.engine.VllmEngine/Generate
```

响应：

```json
{
  "complete": {
    "outputIds": [17993, 1894, 7332, 198, 286, 2415, 1140, 259, 4580, 892],
    "finishReason": "length",
    "promptTokens": 1,
    "completionTokens": 10
  }
}
```

流式请求（设置 `"stream": true`；服务器返回一串 `GenerateResponse` 消息，先是增量的 `chunk` 载荷，最后是一个 `complete` 载荷）：

```bash
grpcurl -plaintext -proto vllm_engine.proto \
    -d '{
        "request_id": "req-2",
        "text": "Hello",
        "sampling_params": {"max_tokens": 10},
        "stream": true
    }' \
    ${IP}:80 vllm.grpc.engine.VllmEngine/Generate
```

<details>
<summary>流式响应</summary>

```text
Response contents:
{
  "chunk": {
    "tokenIds": [
      883336980
    ],
    "promptTokens": 10,
    "completionTokens": 1
  }
}

Response contents:
{
  "chunk": {
    "tokenIds": [
      186949092
    ],
    "promptTokens": 10,
    "completionTokens": 1
  }
}

Response contents:
{
  "chunk": {
    "tokenIds": [
      446163293
    ],
    "promptTokens": 10,
    "completionTokens": 1
  }
}

Response contents:
{
  "chunk": {
    "tokenIds": [
      186949092
    ],
    "promptTokens": 10,
    "completionTokens": 1
  }
}

Response contents:
{
  "chunk": {
    "tokenIds": [
      3509523577
    ],
    "promptTokens": 10,
    "completionTokens": 1
  }
}

Response contents:
{
  "chunk": {
    "tokenIds": [
      1690122482
    ],
    "promptTokens": 10,
    "completionTokens": 1
  }
}

Response contents:
{
  "complete": {
    "finishReason": "stop",
    "promptTokens": 10
  }
}
```

</details>

### vLLM `VllmEngine/Embed`

该方法需要预先分词的输入，以及一个嵌入模型部署。

请求：

```bash
grpcurl -plaintext -proto vllm_engine.proto \
    -d '{
        "request_id": "req-3",
        "tokenized": {"original_text": "Hello", "input_ids": [9906]}
    }' \
    ${IP}:80 vllm.grpc.engine.VllmEngine/Embed
```

响应（为便于阅读，嵌入向量已截断）：

```json
{
  "embedding": [-0.01350, -0.02152, -0.01368, "..."],
  "promptTokens": 1,
  "embeddingDim": 1024
}
```

---

## HTTP 请求头 {#http-headers}

[EPP HTTP 请求头](epp-http-headers.md)（请求分类、流量控制和 SLO 请求头，例如 `x-llm-d-inference-objective` 和 `x-llm-d-inference-fairness-id`）对 gRPC 请求的作用与 HTTP 请求完全相同。

请在调用时以 gRPC 元数据的形式指定它们。使用 grpcurl 时，通过 `-H` 传入：

```bash
grpcurl -plaintext -proto vllm_engine.proto \
    -H 'x-llm-d-inference-objective: my-objective' \
    -H 'x-llm-d-inference-fairness-id: tenant-a' \
    -d '{
        "request_id": "req-4",
        "text": "Hello",
        "sampling_params": {"max_tokens": 10}
    }' \
    ${IP}:80 vllm.grpc.engine.VllmEngine/Generate
```

在 Go 客户端中，把元数据附加到传出的 context 上：

```go
ctx = metadata.AppendToOutgoingContext(ctx,
    "x-llm-d-inference-objective", "my-objective",
    "x-llm-d-inference-fairness-id", "tenant-a")
resp, err := client.Generate(ctx, req)
```

在 Python 中，调用时传入 `metadata`：

```python
stub.Generate(request, metadata=(
    ("x-llm-d-inference-objective", "my-objective"),
    ("x-llm-d-inference-fairness-id", "tenant-a"),
))
```
