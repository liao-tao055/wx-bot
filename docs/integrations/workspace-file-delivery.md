# 工作空间原始文件发送

MCP 0.3.0 扩展原私人微信服务，沿用同一 Worker、Durable Object、
API_TOKEN、本人微信绑定和幂等台账，不创建第二个微信机器人。

## 修复内容

- 扩展名不再只接受 PDF/ZIP。Word、Excel、PPT、TXT、CSV 及其他格式可作为原始附件。
- 文件保留名称和字节。`media.kind=file` 始终使用微信 File 类型，图片或视频扩展名也不转换。
- 明确远端 `file` 参数是主机转换后的文件对象，不是远端可读取的本地路径。
- 主机转换不可用时通过准备票据和 PUT 上传；提供 Python 标准库发送脚本。
- 上传客户端明确标识应用 User-Agent，避免 workers.dev 拒绝默认 Python urllib 标识。
- 准备票据时就核对旧发送记录，匹配的已发送文件返回 `already_sent`，
  不同内容拒绝，未核实记录保持保护；真正发送仍由原子台账去重。
- 工具错误提供结构化错误信息，参数转换失败明确提示备用上传工具。
- 保留 0.2.0 的入站会话诊断、发送者字段兼容修复及受限人工确认重试机制。

## 运行条件

1. 先把修复发布到原 Worker，确认 `/healthz` 的 `X-WxBot-MCP-Version`
   或 `wechat_status.server_version` 为 `0.3.0`。
2. 在目标工作空间接入同一个私人 MCP 地址，并刷新工具。普通 Worker 根地址不是
   MCP 地址，原 URL 含凭据不能公开；私人插件跨工作空间不一定自动可见。
   OpenAI 连接与刷新说明：
   https://developers.openai.com/plugins/build/app-quickstart#connect-your-mcp-server-in-chatgpt
3. 用 `wechat_status` 检查 `logged_in`、`expired`、`context_available` 和 `poll_health`。
   登录过期需要本人重新扫码，缺少上下文需要向 ClawBot 发消息；
   后台不可用时应在 ChatGPT 报告，不发送错误通知到微信。
4. 文件必须存在于运行环境中，单件 1 byte 至 10 MiB。更大文件需由用户决定拆分，
   不在任务中自动更换格式、截断或省略。

原 iLink 服务端仍可能拒绝主动发送；本修复不能替代登录、会话许可、网络或微信侧额度。
`sent` 是插件记录的发送成功，不表示用户已打开或已读。

## 可复用交付指令

以下段落用于已有任务的交付部分；先完成连接与实际验证，再配置任务，不改动原任务的
内容、触发时间、时区、截止日期或文件数量。

> 将本次用户要求的最终文件以原始附件发到原私人“微信推送”绑定的本人微信。
> 文件包括 PDF、ZIP、Word、Excel 等，保留格式、文件名和原始字节。
> 先检查 wechat_status，登录失效或无上下文时保留成果并在 ChatGPT 报告。
> wechat_send_file 的 file 参数必须由主机转换为文件对象；转换不可用时用
> wechat_prepare_file_upload，携带确切字节数、SHA-256，再在同一执行环境 PUT 原文件。
> HTTP 上传标明 User-Agent: wx-bot-workspace/0.3.0，不使用默认 Python urllib 标识。
> PUT 成功已经执行发送，不再走另一路重复发送；already_sent=true 时不上传。
> delivery_id 沿用原项目固定编号、计划触发时点和输出文件名，不用重试时间生成新编号。
> 超时先查 wechat_delivery_status；sending/uncertain 停止自动重发，不换ID或清除记录。
> 所有私人连接、上传票据和凭据仅保留在受保护运行上下文，不进入公开文件或最终回复。
> 逐文件如实记录成功与失败，并在 ChatGPT 保留持久文件链接。没有真实发送结果不能声称微信收到。

## 检查命令

```bash
bun install --frozen-lockfile
bun test
bun run typecheck
python3 -m unittest discover -s scripts/tests -p 'test_*.py'
bun run --cwd packages/cloudflare deploy --dry-run
```

这些检查使用本地模拟微信/HTTP，不给真实微信发测试消息。真实收发还需原私人插件连接
和用户明确要求发送的文件；本地检查通过不等于已部署或送达。
