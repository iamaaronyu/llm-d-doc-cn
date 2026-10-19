# 批处理网关架构

批处理网关为 llm-d 技术栈增加了兼容 OpenAI 的批量推理处理能力。它位于 Batch API 客户端与 llm-d 路由器之间，管理批处理作业的生命周期——从创建作业、分发请求到收集结果。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)">
    <img src="/img/versioned/0.10/assets/batch-gateway.svg" alt="批处理网关架构">
  </picture>
</p>

## API 服务器 {#api-server}

API 服务器暴露兼容 OpenAI 的 REST 端点：

- `POST /v1/files`——上传批处理输入文件（JSONL 格式）。
- `GET /v1/files`——列出文件。
- `GET /v1/files/{id}`——获取文件元数据。
- `GET /v1/files/{id}/content`——下载文件内容（输入或输出文件）。
- `DELETE /v1/files/{id}`——删除文件。
- `POST /v1/batches`——引用已上传的输入文件创建批处理作业。
- `GET /v1/batches/{id}`——获取作业状态、进度计数和输出文件 ID。
- `POST /v1/batches/{id}/cancel`——取消正在运行的作业。
- `GET /v1/batches`——列出批处理作业。

API 服务器校验输入文件的格式约束，把元数据存入数据库（通常是 PostgreSQL），把作业放入优先级队列（通常在 Redis 中），并把文件存储到 S3 或文件系统中。

## 批处理处理器 {#batch-processor}

处理器是核心执行引擎。它：

1. **轮询**优先级队列，获取下一个作业。
2. **读取**输入文件——解析模型 ID 和系统提示词，按模型对请求分组，并为每个模型构建执行计划。
3. **并发执行**计划——为每个模型启动 goroutine，在并发限制下把单个推理请求发送给 llm-d 路由器，并把结果写入输出文件。
4. 在处理过程中**更新**作业状态，并监听作业事件（如取消）。
5. **收尾**——上传输出文件并更新作业状态。

### 并发控制 {#concurrency-control}

处理器使用两级并发控制，防止 llm-d 路由器过载：

- **全局并发**——限制所有模型的进行中请求总数。
- **每模型并发**——限制单个模型的进行中请求数。

### 崩溃恢复 {#crash-recovery}

启动时，处理器会扫描在上一个实例崩溃时处于 `in_progress` 状态的作业。如果存在部分输出文件，处理器会上传该文件并将作业标记为失败；否则，作业会重新入队以完整重试。恢复的并发度有上限，以免在重启风暴期间压垮系统。

## 存储层 {#storage-layer}

批处理网关的所有组件共享一个可插拔的存储层：

| 功能 | 可选项 | 说明 |
|----------|---------|-------|
| 作业和文件元数据 | PostgreSQL、Redis、Valkey | 生产环境使用 PostgreSQL；Redis 和 Valkey 仅用于开发/测试 |
| 优先级队列 | Redis、Valkey | 基于 SLO 优先级的有序集合 |
| 事件通道 | Redis、Valkey | 用于作业取消及未来支持的其他事件的 Pub/Sub |
| 状态更新 | Redis、Valkey | 作业处理进度跟踪 |
| 文件存储 | S3、文件系统 | 多副本部署使用 S3；单节点使用文件系统（PVC） |

## 垃圾回收器 {#garbage-collector}

GC 按可配置的间隔运行，并删除：

- 过期的批处理作业（超过其 `completion_window`）。
- 过期的文件（超过其配置的过期时间）。

它会限制并发删除的数量，以免给数据库带来压力。

## 认证与多租户 {#authentication-and-multi-tenancy}

批处理网关把认证和授权委托给上游网关基础设施：

- API 服务器从 HTTP 请求头（可配置）中提取租户标识符。
- 所有数据查询都按租户 ID 过滤。跨租户访问会被拒绝。
- 处理器在每个推理请求中转发可配置的透传请求头，使 llm-d 路由器能够按请求对终端用户进行认证和授权。
- 文件路径按租户 ID 做哈希，以防止被枚举。

批处理路由负责认证（验证身份），推理路由负责授权（验证模型访问权限）。这种分离确保创建批处理作业时不需要每个模型的权限——授权在推理时执行。

## 可观测性 {#observability}

- **Prometheus 指标**：请求计数、作业处理时间、队列等待时长、工作线程利用率、每模型并发和 token 计数。
- **OpenTelemetry 链路追踪**：贯穿 API 服务器、处理器、数据库以及 llm-d 路由器调用的分布式追踪。
- **Grafana 仪表盘**：Helm Chart 中包含针对 API 服务器和处理器指标的预置仪表盘。
- **Prometheus 告警规则**：可配置的告警，涵盖队列等待时间过长、作业失败率、过期作业和工作线程饱和。

## 相关内容 {#related}

- [批处理网关部署指南](https://github.com/llm-d/llm-d/tree/v0.10.0/guides/batch-serving/batch-gateway)——部署说明、配置选项和使用方法。
- [批处理网关仓库](https://github.com/llm-d/llm-d-batch-gateway)——源代码、Helm Chart、部署和使用指南。
- [批处理网关设计文档](https://github.com/llm-d/llm-d-batch-gateway/tree/v0.6.0/docs/design)——详细的设计文档。
- [异步处理器](async-processor.md)——与批处理网关组合使用，实现带门控的请求分发。
