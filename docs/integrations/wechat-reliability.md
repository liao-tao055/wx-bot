# 微信定时交付的有条件恢复

> 当前个人 MCP 0.4.0 已按本人授权启用[云端持续重试直到 sent](wechat-until-sent.md)。以下一次人工重试规则仅适用于旧版未加入队列的记录；新队列任务不需要逐次确认，调用方也不重复上传。

这次修改缓解已建立会话后主动发送失败的问题，不承诺微信长期无限制推送。
`logged_in=true` 仅表示保存了登录信息，不能代替真实发送结果。

## 恢复边界

- Cloudflare 客户端启用 `recoverStaleContext`，发送请求至少间隔一秒，并串行发送。
- 仅在服务器明确返回 `ret=-2` 或 `errcode=-2`，且 `errmsg` 恰好为
  `unknown error` / `prepare failed`，并且该用户已有入站上下文时，移除这次请求的
  上下文重试一次。认证、固定本人收件人、原消息、原 `client_id` 保留。
- 恢复成功后，同一失效上下文的后续消息继续使用恢复模式；新的入站上下文到达时
  优先使用新上下文。首次使用仍需用户先向机器人发消息。
- 文件恢复只重试被拒绝的消息，不重新上传文件，也不重发已经成功的标题。
- 超时、网络错误、HTTP 错误、明确的 `rate limited`、无具体说明的 `-2` 不触发该恢复。
  登录过期 `-14` 仍需要扫码。恢复后仍拒绝的情况停止自动重发并报告原始错误字段。
- 此策略不能绕过微信服务端的发送额度、会话许可或封禁；某些账号仍需新的入站消息。
  不发送心跳消息，不把“自动重试”当成已经送达。

## 可观测性

保留经过凭证脱敏的 `ret`、`errcode` 和 `errmsg`；普通 API 的状态以及
MCP 的 `wechat_status` 新增 `last_send`，显示最近发送的成功/失败和时间。
原有交付回执去重、`sending` / `uncertain` 停止自动重发规则继续生效。
core 客户端的恢复默认关闭，仅 Cloudflare 本人绑定显式启用。

## 依据与验证

相关实现者已报告过一次无上下文恢复成功，也报告过微信端仍拒绝的情况，
不能仅凭 `ret=-2` 断言原因或承诺固定有效期：

- https://github.com/NousResearch/hermes-agent/issues/80125
- https://github.com/NousResearch/hermes-agent/issues/56814

回归验证：`bun test`、`bun run typecheck`、
`bun run --cwd packages/cloudflare deploy --dry-run`。
单元测试使用模拟服务，不代替实际部署后的跨时段测试。
