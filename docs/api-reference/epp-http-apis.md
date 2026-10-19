# EPP HTTP API 参考

本文列出[端点选择器（EPP）](../architecture/core/router/epp)为推理流量支持的 HTTP API。视 API 而定，EPP 可能会解析请求体中的字段，用于前缀缓存感知路由和插件决策。

## 支持的 HTTP API {#supported-http-apis}

| 端点 | 来源 | 是否支持 |
| --- | --- | --- |
| `/v1/completions` | OpenAI Completions API | ✅ |
| `/v1/chat/completions` | OpenAI Chat Completions API | ✅ |
| `/v1/responses` | OpenAI Responses API | ✅ |
| `/v1/embeddings` | OpenAI Embeddings API | ✅ |
| `/v1/messages` | Anthropic Messages API | ✅ |
| `/inference/v1/generate` | vLLM Generate API | ✅ |

---

## 请求示例 {#request-examples}

下面的示例将模型参数化为 `${MODEL_NAME}`，将代理端点参数化为 `${IP}`。请把 `${MODEL_NAME}` 设为[多模态聚合部署指南](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/multimodal-serving/aggregation)中的 [`Qwen/Qwen3-VL-32B-Instruct`](https://huggingface.co/Qwen/Qwen3-VL-32B-Instruct)，并把 `${IP}` 设为按该指南验证步骤获取的代理端点 IP。

```bash
export MODEL_NAME=Qwen/Qwen3-VL-32B-Instruct
```

`/v1/embeddings` 一节会覆盖 `${MODEL_NAME}`，因为对话/指令模型不提供该路由。

### OpenAI `/v1/completions`

请求：

```bash
curl -X POST http://${IP}/v1/completions \
    -H 'Content-Type: application/json' \
    -d '{
        "model": "'"${MODEL_NAME}"'",
        "prompt": "Hello",
        "max_tokens": 10
    }' | jq
```

响应：

```json
{
  "id": "cmpl-abc123",
  "object": "text_completion",
  "created": 1781036021,
  "model": "Qwen/Qwen3-VL-32B-Instruct",
  "choices": [
    {
      "index": 0,
      "text": "! I am trying to write a story, and",
      "logprobs": null,
      "finish_reason": "length",
      "stop_reason": null
    }
  ],
  "system_fingerprint": "vllm-0.21.0-tp2-5054d0df",
  "usage": {
    "prompt_tokens": 1,
    "total_tokens": 11,
    "completion_tokens": 10
  }
}
```

流式请求（设置 `stream: true`；响应是服务器发送事件（SSE），因此去掉 `jq` 并使用 `curl -N`，以便分块到达时立即输出）：

```bash
curl -N -X POST http://${IP}/v1/completions \
    -H 'Content-Type: application/json' \
    -d '{
        "model": "'"${MODEL_NAME}"'",
        "prompt": "Hello",
        "max_tokens": 10,
        "stream": true
    }'
```

### OpenAI `/v1/chat/completions`

请求：

```bash
curl -X POST http://${IP}/v1/chat/completions \
    -H 'Content-Type: application/json' \
    -d '{
        "model": "'"${MODEL_NAME}"'",
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Describe this image."},
                    {"type": "image_url", "image_url": {"url": "https://picsum.photos/640/360"}}
                ]
            }
        ],
        "max_tokens": 10
    }' | jq
```

流式请求：

```bash
curl -N -X POST http://${IP}/v1/chat/completions \
    -H 'Content-Type: application/json' \
    -d '{
        "model": "'"${MODEL_NAME}"'",
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Describe this image."},
                    {"type": "image_url", "image_url": {"url": "https://picsum.photos/640/360"}}
                ]
            }
        ],
        "max_tokens": 10,
        "stream": true
    }'
```

<details>
<summary>流式响应（SSE）</summary>

```
data: {"id":"cmpl-abc124","object":"text_completion","created":1781036045,"model":"Qwen/Qwen3-VL-32B-Instruct","choices":[{"index":0,"text":"!","logprobs":null,"finish_reason":null,"stop_reason":null}]}

data: {"id":"cmpl-abc124","object":"text_completion","created":1781036045,"model":"Qwen/Qwen3-VL-32B-Instruct","choices":[{"index":0,"text":" I","logprobs":null,"finish_reason":null,"stop_reason":null}]}

data: {"id":"cmpl-abc124","object":"text_completion","created":1781036045,"model":"Qwen/Qwen3-VL-32B-Instruct","choices":[{"index":0,"text":"'m","logprobs":null,"finish_reason":null,"stop_reason":null}]}

data: {"id":"cmpl-abc124","object":"text_completion","created":1781036045,"model":"Qwen/Qwen3-VL-32B-Instruct","choices":[{"index":0,"text":" a","logprobs":null,"finish_reason":null,"stop_reason":null}]}

data: {"id":"cmpl-abc124","object":"text_completion","created":1781036045,"model":"Qwen/Qwen3-VL-32B-Instruct","choices":[{"index":0,"text":" student","logprobs":null,"finish_reason":null,"stop_reason":null}]}

data: {"id":"cmpl-abc124","object":"text_completion","created":1781036045,"model":"Qwen/Qwen3-VL-32B-Instruct","choices":[{"index":0,"text":" of","logprobs":null,"finish_reason":null,"stop_reason":null}]}

data: {"id":"cmpl-abc124","object":"text_completion","created":1781036045,"model":"Qwen/Qwen3-VL-32B-Instruct","choices":[{"index":0,"text":" the","logprobs":null,"finish_reason":null,"stop_reason":null}]}

data: {"id":"cmpl-abc124","object":"text_completion","created":1781036045,"model":"Qwen/Qwen3-VL-32B-Instruct","choices":[{"index":0,"text":" ","logprobs":null,"finish_reason":null,"stop_reason":null}]}

data: {"id":"cmpl-abc124","object":"text_completion","created":1781036045,"model":"Qwen/Qwen3-VL-32B-Instruct","choices":[{"index":0,"text":"1","logprobs":null,"finish_reason":null,"stop_reason":null}]}

data: {"id":"cmpl-abc124","object":"text_completion","created":1781036045,"model":"Qwen/Qwen3-VL-32B-Instruct","choices":[{"index":0,"text":"0","logprobs":null,"finish_reason":"length","stop_reason":null}],"system_fingerprint":"vllm-0.21.0-tp2-5054d0df"}

data: [DONE]
```

</details>

### OpenAI `/v1/responses`

请求：

```bash
curl -X POST http://${IP}/v1/responses \
    -H 'Content-Type: application/json' \
    -d '{
        "model": "'"${MODEL_NAME}"'",
        "input": "Hello",
        "max_output_tokens": 10
    }' | jq
```

响应：

```json
{
  "id": "resp_abc127",
  "created_at": 1781036107,
  "incomplete_details": {"reason": "max_output_tokens"},
  "model": "Qwen/Qwen3-VL-32B-Instruct",
  "object": "response",
  "output": [
    {
      "id": "msg_abc128",
      "type": "message",
      "role": "assistant",
      "status": "completed",
      "content": [
        {
          "type": "output_text",
          "text": "Hello! How can I help you today?",
          "annotations": []
        }
      ]
    }
  ],
  "status": "incomplete",
  "max_output_tokens": 10,
  "usage": {
    "input_tokens": 9,
    "output_tokens": 10,
    "total_tokens": 19
  }
}
```

### OpenAI `/v1/embeddings`

该端点需要部署嵌入模型（例如 `Qwen/Qwen3-Embedding-0.6B`）。对话/指令模型不提供该路由。

请求：

```bash
export MODEL_NAME=Qwen/Qwen3-Embedding-0.6B
curl -X POST http://${IP}/v1/embeddings \
    -H 'Content-Type: application/json' \
    -d '{
        "model": "'"${MODEL_NAME}"'",
        "input": "Hello"
    }' | jq
```

响应（为便于阅读，嵌入向量已截断）：

```json
{
  "model": "Qwen/Qwen3-Embedding-0.6B",
  "object": "list",
  "data": [
    {
      "index": 0,
      "object": "embedding",
      "embedding": [-0.01350, -0.02152, -0.01368, -0.03032, 0.00941, "..."]
    }
  ],
  "usage": {
    "prompt_tokens": 2,
    "total_tokens": 2,
    "completion_tokens": 0
  }
}
```

### Anthropic `/v1/messages`

请求：

```bash
curl -X POST http://${IP}/v1/messages \
    -H 'Content-Type: application/json' \
    -d '{
        "model": "'"${MODEL_NAME}"'",
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Describe this image."},
                    {"type": "image", "source": {"type": "url", "url": "https://picsum.photos/640/360"}}
                ]
            }
        ],
        "max_tokens": 10
    }' | jq
```

响应：

```json
{
  "id": "chatcmpl-abc125",
  "type": "message",
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "This image is a close-up, shallow-focus photograph"
    }
  ],
  "model": "Qwen/Qwen3-VL-32B-Instruct",
  "stop_reason": "max_tokens",
  "usage": {
    "input_tokens": 234,
    "output_tokens": 10
  }
}
```

流式请求：

```bash
curl -N -X POST http://${IP}/v1/messages \
    -H 'Content-Type: application/json' \
    -d '{
        "model": "'"${MODEL_NAME}"'",
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Describe this image."},
                    {"type": "image", "source": {"type": "url", "url": "https://picsum.photos/640/360"}}
                ]
            }
        ],
        "max_tokens": 10,
        "stream": true
    }'
```

<details>
<summary>流式响应（SSE）</summary>

```
event: message_start
data: {"type":"message_start","message":{"id":"chatcmpl-abc126","content":[],"model":"Qwen/Qwen3-VL-32B-Instruct","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":234,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","content_block":{"type":"text","text":""},"index":0}

event: content_block_delta
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"This"},"index":0}

event: content_block_delta
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" image"},"index":0}

event: content_block_delta
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" captures"},"index":0}

event: content_block_delta
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" a"},"index":0}

event: content_block_delta
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" serene"},"index":0}

event: content_block_delta
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" and"},"index":0}

event: content_block_delta
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" atmospheric"},"index":0}

event: content_block_delta
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" urban"},"index":0}

event: content_block_delta
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" landscape"},"index":0}

event: content_block_delta
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" at"},"index":0}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"input_tokens":234,"output_tokens":10}}

event: message_stop
data: {"type":"message_stop"}
```

</details>

### vLLM `/inference/v1/generate`

该端点要求模型服务器为 vLLM。采样控制参数必须嵌套在 `sampling_params` 对象中，而不能放在顶层。

请求：

```bash
curl -X POST http://${IP}/inference/v1/generate \
    -H 'Content-Type: application/json' \
    -d '{
        "model": "'"${MODEL_NAME}"'",
        "token_ids": [9906],
        "sampling_params": {"max_tokens": 10}
    }' | jq
```

响应：

```json
{
  "request_id": "abc129",
  "choices": [
    {
      "index": 0,
      "logprobs": null,
      "finish_reason": "length",
      "token_ids": [17993, 1894, 7332, 198, 286, 2415, 1140, 259, 4580, 892]
    }
  ]
}
```
