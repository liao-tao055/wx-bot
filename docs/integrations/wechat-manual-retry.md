# 微信原编号人工补发与诊断修复

本次修复基于 liao-tao055/wx-bot 的 eebf91e33377c0e7cd69e129937ffc7209408c2e。
不更换 Worker、绑定 tong、现有 API_TOKEN、MCP 私有连接或微信账号。

## 已确认的问题

旧版会把发送失败但不能确定结果的交付存为 `uncertain`，保留七天。
所有后续同编号请求都会被拒绝；用户已检查未收到并明确授权也没有恢复入口。
登录状态正常不能证明消息成功，也不能说明最近的微信入站消息已被轮询收到。

## 修改

1. `wechat_confirm_not_received` 只在用户本人检查微信、确认该项未收到并明确授权
   一次重试后使用。必须提交原 delivery_id 和最新 updated_at，两个确认值必须为 true。
   沉默、发送“你好”、超时、自动化运行本身都不是人工补发授权。
2. 仅接受已持续至少 30 秒的 `uncertain`；禁止解锁 `sending`、`sent` 和过期记录。
   它不发送消息、不删除记录、不换编号，只原子地授予一次 `retry_ready`。
   再次发送仍核对原收件人、标题、文件名和文件 SHA-256，不能替换内容。
3. 并发请求只能消耗一次授权。成功后仍按原编号去重；再次结果不明则再次停止，
   不把一次人工授权当作无限重试许可。重复相同确认请求在授权未消耗时是幂等操作。
4. `wechat_status` 新增 `server_version=0.2.0`、`context_available`、
   `context_observed_at` 和 `poll_health`；仅显示上下文是否存在及观测时间，不返回 token。
   发现有效登录没有轮询 alarm 时补设 alarm，唤醒收消息，不发送保活消息。
5. 发送消息的 `from_user_id` 改为空字符串，与微信官方 SDK 的出站请求一致。
   认证仍使用原机器人 token，收件人仍严格限定扫码本人。
   参考 @tencent-weixin/openclaw-weixin 2.4.10 的 src/messaging/send.ts
   （buildTextMessageReq、sendMessageItemWeixin、sendMediaMessageWeixin）。
   https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin/v/2.4.10
   这项协议兼容性修正尚不能单独证明原 prepare failed 的根因。

## 部署后补发

1. 等待原 Cloudflare Git 自动部署成功，微信插件状态显示 server_version 0.2.0。
2. 用旧编号查状态。若显示 sent，不再发送；若 sending，不能解锁。
3. 仅在用户已经检查并明确授权的前提下，调用 wechat_confirm_not_received，
   使用最新 updated_at，两个人工确认值为 true；返回 sent=false 表示此调用没有发消息。
4. 用原编号、原文件、原标题发送一次。核实微信原始 PDF 附件及返回状态。
5. 若仍报 prepare failed，查看 context_observed_at 和 poll_health；不要因为
   logged_in=true 就宣称已恢复，不换 ID 重试，不直接修改底层交付表。

若 ChatGPT 暂时没加载新工具，可刷新原连接的工具列表。已有私有连接不用重新创建。
受同一 Bearer API_TOKEN 保护的 POST /b/tong/mcp-deliveries/confirm-not-received
也接受同样四个字段；不是免认证的解锁接口。不要在聊天、日志或代码包内公布凭证。

## 尚需实测

单元测试和 Wrangler 打包演练不能代替生产部署与微信真实附件送达验证。
该修改不保证绕过微信服务端的会话限制、限流、登录失效或其它上游错误。
人工授权重试仍存在旧请求延迟完成后重复送达的可能，必须让用户明确知情。
