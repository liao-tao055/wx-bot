# ChatGPT 个人微信推送

> 当前个人 MCP 0.4.0 已按本人授权启用[云端持续重试直到 sent](wechat-until-sent.md)。以下一次人工重试规则仅适用于旧版未加入队列的记录；新队列任务不需要逐次确认，调用方也不重复上传。

在已经部署的 Cloudflare Worker 上增加个人 MCP 接口。沿用现有 `WXBOT`
Durable Object 和 `API_TOKEN`，不需要新的数据库、API 模型付费账号或常开的手机。
现有登录、收发和健康检查接口保留。

## 连接

先部署本次修改，然后用已有 API_TOKEN 请求：

```bash
curl --fail-with-body -sS \
  -H "Authorization: Bearer $WX_TOKEN" \
  'https://YOUR-WORKER/b/tong/mcp-link' | jq -r .server_url
```

返回的专用地址本身就是凭证，不能公开、截图分享、写入公开仓库或放进插件压缩包。
它使用 HMAC 从 API_TOKEN 和绑定名派生，不包含 API_TOKEN 原文，且只允许对该绑定
的扫码本人发送。更换 API_TOKEN 会让旧连接地址及上传票据失效。

在 ChatGPT **网页版 → 插件 → 添加 → 添加自定义 MCP 服务器**，填入该地址。
身份验证选 **No authentication**：客户端不需要额外的 OAuth，服务器仍会验证地址
内的专用访问凭证。创建并安装为自己的私人插件。普通 Worker 根网址不是 MCP 地址。

## 工具

| 工具 | 用途 |
| --- | --- |
| `wechat_status` | 查看该绑定是否已登录 |
| `wechat_send_text` | 将纯文本发送给扫码本人，可加任务标题 |
| `wechat_send_file` | 通过主机文件对象发送任意格式的原始附件，包括 PDF、ZIP、Word、Excel |
| `wechat_prepare_file_upload` | 文件参数不可用时取得 5 分钟有效的 PUT 上传地址 |
| `wechat_delivery_status` | 检查同一次交付的状态，防止超时后重复发送 |

支持 MCP `2026-07-28` 的无会话 Streamable HTTP，以及 `2025-03-26`、`2025-06-18`、
`2025-11-25` 的初始化握手。不提供 SSE GET 长连接或主动事件订阅。

每份附件上限 10 MiB，保留原文件名，接收方在普通微信里收到文件卡片。
MCP 0.3.0 不再限制文件扩展名；Word、Excel、PowerPoint、文本、图片和其他二进制
文件均按原始文件发送，不转成 PDF，也不把图片或视频扩展名自动改成媒体消息。
PDF 和 ZIP 类文档仍检查基本文件头，文件大小、本人接收方及去重限制保留。
文件参数通过 `_meta["openai/fileParams"]` 交给主机处理；主机将可访问的本地文件
转换为临时下载引用。下载只允许 OpenAI 文件托管地址；每次重定向也会重新检查。
该主机行为必须在实际 ChatGPT 会话里验证；单元测试的模拟不能代替连接测试。
服务端的 `file` 实际收到 `{download_url, file_id, mime_type?, file_name?}`，
不能直接传 `/workspace/.../report.docx` 字符串。主机没有完成转换时使用下面的 PUT 路径。
OpenAI 文件输入规范：https://developers.openai.com/plugins/reference#define-file-inputs

如果文件参数没有被主机转换，先对最终文件计算 SHA-256 和字节数，调用
`wechat_prepare_file_upload`，然后在生成文件的同一个云端执行环境里执行：

```bash
curl --fail-with-body -sS -H 'User-Agent: wx-bot-workspace/0.3.0' \
  --upload-file '/absolute/path/report.pdf' "$UPLOAD_URL"
```

上传地址绑定文件名、字节数、SHA-256、有效期及当时的微信本人身份；接口核验后直接
发送附件。无需把文件先下载到手机。不要在聊天最终回复里展示上传地址。
重复准备同一编号时，已发送且文件哈希、标题、名称一致的记录返回
`already_sent=true`，不再提供上传地址；内容不同或仍为 `uncertain/sending` 时拒绝。
不要因未返回上传地址就换编号重试。

## 工作空间文件发送脚本

主机未提供文件参数转换时，也可在文件所在工作空间运行 `scripts/wechat-send-files.py`。
仅依赖 Python 3 标准库。私人 MCP 地址从受保护环境变量 `WXBOT_MCP_URL` 读取，
不通过命令行参数传递、不写入任务提示词或公开文件。

```bash
# 只读检查，不发送
python3 scripts/wechat-send-files.py --check

# 仅在用户已要求发送这些文件、且连接已配置时运行
python3 scripts/wechat-send-files.py \
  --task-id '<原项目固定编号>' \
  --scheduled-for '2026-11-01T11:00:00+08:00' \
  --title '数学竞赛每日预测卷' \
  /workspace/output/预测题.pdf /workspace/output/详细解答.docx \
  /workspace/output/成绩.xlsx /workspace/output/项目.zip
```

脚本冻结原始字节，计算 SHA-256，检查原编号状态，准备票据，直接上传，并再次核对
发送状态。同次运行重试必须保留任务编号、计划触发时间、名称和内容。
网络响应丢失时先查询，不再次上传；`uncertain/sending` 不自动解除。
脚本不会创建调度、连接插件、登录微信或授予人工补发许可。
脚本使用明确标识本应用的 User-Agent；Cloudflare 的 workers.dev 可能对默认 Python
urllib 标识返回 403 / 1010，导致请求未到达 Worker。不要把这种返回当作微信登录失效。
参考：https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/
普通已连接插件可直接调用状态/准备上传工具，再在工作空间 PUT，无需把私人 MCP 地址
另存为脚本环境变量。

连接到新工作空间后需要刷新原私人插件的工具列表。部署 Worker、插件连接、文件字节
转换和实际微信收到附件是不同检查项，不能把本地测试当作全部接通。

## 定时任务

接入插件后，先在普通会话中实际发送文字、PDF 和 ZIP，再修改原有定时任务的交付说明。
仅部署 Worker 或仅创建插件，都不等于已完成定时推送。保留原任务的内容、时间、
结束日期和文件要求。每次运行用任务 ID、计划触发时间和文件名生成稳定 `delivery_id`。
七天内，同一个 ID 与同样内容只交付一次；同一个 ID 不能用来发送另一份内容。

发送前需要用户给新的 ClawBot 会话发过一条消息。出现 `no_context` 时请用户发送新消息；
出现 `expired` 时需要重新扫码。错误应在 ChatGPT 中报告，不通过不可用的微信通道回传。
上游超时会标为 `uncertain`，或在进程中断时保留 `sending`；应检查交付状态及微信，
不能换一个 ID 自动重发。文件上传票据可重新申请，但继续使用原 `delivery_id`。

所有任务发到同一个本人 ClawBot 会话，使用任务标题区分；本实现不创建微信聊天群。

## 验证

```bash
bun test
bun run typecheck
bun run --cwd packages/cloudflare deploy --dry-run
python3 -m unittest discover -s scripts/tests -p 'test_*.py'
```

测试使用模拟微信收件人，不会向真实账号发送消息。上线后还需验证真实插件连接、
文件参数转换和无人值守的定时交付。
