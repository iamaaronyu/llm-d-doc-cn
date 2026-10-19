# 多模态工作负载服务

多模态输入正在从根本上改变生产 LLM 流量的形态。
一个提示词不再只有文本，还包含密集的非文本模态——高分辨率图像、视频帧或音频片段。
传统 HTTP 请求速度快、形态统一、成本低。标准的轮询请求调度策略可以很好地均衡这类负载。
LLM 请求打破了这三个假设。多模态 LLM 请求（包含图像、视频或音频）则打破得更彻底：

* **上下文急剧膨胀**——一张高分辨率图像、一段音频或一个视频文件会大幅撑大上下文窗口（通常增加数千个 token）。
* **prefill 成本高昂**——运行视觉/听觉编码器并对数千个 token 进行 prefill 非常消耗资源。

**llm-d 路由器**通过在分布式集群中追踪、哈希和匹配复杂的多模态载荷，把基于文本的前缀调度扩展到聚合式和分离式两种推理架构。
路由器会把请求智能地导向那些已经在内存中持有对应的预计算编码器缓存和 KV 块的后端工作节点。
无论是统一拓扑，还是 encode-prefill-decode 分离（E/P/D 分离）的部署形态，这种定向路由都能最大化硬件效率并消除冗余处理。

---

## 部署 {#deploy}

### 多模态聚合式指南 {#multimodal-aggregated-guide}

聚合式部署的清单文件和分步部署说明请参阅[多模态聚合指南](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/multimodal-serving/aggregation)。

### 多模态分离式指南 {#multimodal-disaggregated-guide}

分离式部署的清单文件和分步部署说明请参阅[多模态 E 分离指南](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/multimodal-serving/e-disaggregation)。

---

## 架构与调度 {#architecture--scheduling}

llm-d 路由器利用前缀缓存亲和性和服务器负载指标来调度多模态请求。

:::note
高层调度架构流程以及 EPP 负载均衡示意图，请参阅[优化基线指南](../foundations/optimized-baseline.md#architecture)。
:::


### 前缀感知调度 {#prefix-aware-scheduling}

#### 近似前缀缓存感知路由 {#approximate-prefix-cache-aware-routing}

EPP 在内存中维护每个端点的前缀缓存状态视图（同时包括文本和多模态资源），并优先把请求路由到前缀缓存匹配度高的端点。在其针对文本输入的近似前缀缓存匹配算法基础上，EPP 会以数学方式估算每个多模态资源的虚拟 token 占用。

EPP 使用两种高度可定制的 **Token 估算策略**：

##### 提供资源元数据 {#providing-asset-metadata}

两种策略都需要每个资源的元数据（图像的尺寸；视频的时长、帧率和分辨率）来估算其 token 占用。EPP 按如下方式获取这些元数据：

* **图像**——当图像以内联方式（原始字节）嵌入请求时，EPP 直接从图像内容中读取其宽度和高度。当图像以 URL 形式提供时，EPP **不会**获取远程内容，而是回退到其配置的默认值。
* **视频**——EPP 无法直接检查视频内容，因此客户端应通过请求头提供视频元数据。省略的请求头会回退到 EPP 对应的默认值：
  * `x-llm-d-video-fps`——视频的每秒帧数。
  * `x-llm-d-video-duration-seconds`——视频的时长（秒）。
  * `x-llm-d-video-resolution`——视频帧分辨率，格式为 `WIDTHxHEIGHT`（例如 `1280x720`）。

##### A. 基于尺寸的近似估算（例如 Qwen-VL） {#a-dimension-based-approximation-eg-qwen-vl}

###### 图像 {#image}

根据图像的宽度和高度估算 token 数：
$$\text&#123;Tokens&#125; = \frac&#123;\text&#123;Image Width&#125; \times \text&#123;Image Height&#125;&#125;&#123;\text&#123;Factor&#125;&#125;$$

* `Factor` 参数可按 EPP 配置：
  * 对于 **Qwen 2.5 VL**：`factor = 784`（即 $28 \times 28$）
  * 对于 **Qwen 3.5 VL**：`factor = 1024`（即 $32 \times 32$）

###### 视频 {#video}

token 数估算为每帧 token 数乘以采样帧数：
$$\text&#123;Tokens&#125; = \text&#123;tokensPerFrame&#125; \times \text&#123;Number of frames&#125;$$

* **tokensPerFrame**——在 `dynamic` 模式下复用图像公式（$\text&#123;width&#125; \times \text&#123;height&#125; / \text&#123;factor&#125;$）。
* **帧数**——Qwen3-VL 使用 **sampled（采样）**策略：视频按 `sampleFPS` 采样，限制在 `[minFrames, maxFrames]` 范围内，然后每 `temporalPatchSize` 个采样帧合并为一个 token 组：
$$\text&#123;Number of frames&#125; = \frac&#123;\text&#123;clamp&#125;(\text&#123;duration&#125; \times \text&#123;sampleFPS&#125;,\ \text&#123;minFrames&#125;,\ \text&#123;maxFrames&#125;)&#125;&#123;\text&#123;temporalPatchSize&#125;&#125;$$

总数受 `maxVideoTokens` 限制。Qwen3-VL 的 EPP 配置示例：

```yaml
estimate:
  video:
    tokensPerFrame:
      mode: dynamic
      dynamic:
        factor: 1024          # 32 × 32
    frames:
      mode: sampled
      minFrames: 4
      maxFrames: 768
      sampled:
        sampleFPS: 2
        temporalPatchSize: 2
    maxVideoTokens: 12288
```

##### B. 基于配置的固定分配（例如 Gemma 4） {#b-configuration-based-fixed-allocation-eg-gemma-4}

直接使用用户配置中与模型支持级别相匹配的固定值：

###### 图像 {#image-1}

* Gemma 4 支持的取值：每张图像 70、140、280（默认）、560 或 1120 个 token。

###### 视频 {#video-1}

token 数估算为固定的每帧分配量乘以帧数：
$$\text&#123;Tokens&#125; = \text&#123;tokensPerFrame&#125; \times \text&#123;Number of frames&#125;$$

* **tokensPerFrame**——直接取自用户配置的常量每帧值（`static` 模式）。
* **帧数**——Gemma 4 使用 **strided（跨步）**策略：每隔 `frameStride` 个源帧取一帧，并限制在 `[minFrames, maxFrames]` 范围内：
$$\text&#123;Number of frames&#125; = \text&#123;clamp&#125;\left(\frac&#123;\text&#123;duration&#125; \times \text&#123;sourceFPS&#125;&#125;&#123;\text&#123;frameStride&#125;&#125;,\ \text&#123;minFrames&#125;,\ \text&#123;maxFrames&#125;\right)$$

Gemma 4 的 EPP 配置示例：

```yaml
estimate:
  video:
    tokensPerFrame:
      mode: static
      static:
        numTokensPerFrame: 296
    frames:
      mode: strided
      minFrames: 1
      maxFrames: 8
      strided:
        frameStride: 4
```

#### 精确前缀缓存感知路由 {#precise-prefix-cache-aware-routing}

这种路由策略直接依据各个模型服务器端点精确、实时的物理内存块状态做出路由决策。它要求路由器对输入进行分词，并订阅模型服务器端点的 KV 事件通道。路由器内部维护一个**索引器**，为集群中驻留的每个块维护 `block key → model server endpoints` 映射。
对于到达的请求，路由器把分词后的输入切分成块，并用块键在索引器中匹配，确定哪个模型服务器端点的前缀匹配最长。多模态资源会结合资源哈希和大小转换为块键，从而被正确计入。

---

### 负载感知路由 {#load-aware-routing}

EPP 以固定间隔（默认 50ms）抓取每个端点的 `/metrics`，持续探测其指标。它根据队列深度、运行中的请求数和 KV 缓存利用率为端点打分，把请求调度到负载最低的端点，避免异构请求模式造成的热点。

---

## 延伸阅读 {#further-reading}

* 基于文本的调度和通用负载均衡细节请参阅[优化基线](../foundations/optimized-baseline.md)。
* 更多细节请参阅 [EPP 架构](../../architecture/core/router/epp/README.md)。
* 基于事件的精确索引细节请参阅 [KV 缓存索引器](../../architecture/advanced/kv-management/kv-indexer.md)。
