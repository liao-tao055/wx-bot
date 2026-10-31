# 微信会话生命周期修复

MCP 0.3.4 在 Cloudflare 客户端初始化时调用官方 SDK 已使用的
`POST /ilink/bot/msg/notifystart`，仅上报 `base_info`，沿用原机器人认证。
这不是聊天消息，也不会发保活文字。

旧客户端只在 `prepare failed` 后尝试一次去掉上下文的发送；如果这次也失败，
没有会话生命周期恢复步骤。新增逻辑在明确的发送准备拒绝后，重新初始化客户端、
上报启动并重启长轮询。超时、HTTP 故障、CDN 错误不会触发此恢复。
恢复每个绑定一分钟最多一次，并合并并发恢复。它不重发原消息、不改交付记录。

初始化采用一个共享 Promise，防止同一绑定的轮询与发送在冷启动时各自创建客户端、
持有不同的上下文 Map。会话切换会使旧初始化失效，防止旧凭证覆盖新客户端。

`wechat_status` 新增 `session_start` 与 `session_recovery`，展示启动/恢复请求的
成功标志、时间与脱敏错误。成功标志仅代表生命周期调用成功，不代表附件已送达。
微信接口若仍拒绝，原错误与 `uncertain` 交付状态继续保留，必须由本人核实后处理。

协议参考：腾讯 SDK 的 `src/api/api.ts` 中 `notifyStart`。
https://github.com/Tencent/openclaw-weixin/blob/main/src/api/api.ts

腾讯仓库中仍未合并的 PR #335 也讨论了 tokenless 尝试仍失败时的会话恢复，
仅作为诊断参考，不能据此认定每个 `prepare failed` 都是同一根因。
https://github.com/Tencent/openclaw-weixin/pull/335

本修复不会生成新的微信上下文，也不能保证绕过微信服务端对主动消息的限制。
生产验证必须分别确认版本上线、生命周期结果和真实附件发送结果。

部署将 Durable Objects 的 `code_update_strategy` 显式设为 `immediate`，
让持续长轮询的绑定对象立即采用修复。`wechat_status.binding_server_version`
用于区分入口 Worker 版本与绑定对象实际运行版本，避免把入口升级当成恢复已生效。
冷启动的状态检查也会初始化客户端，并报告真实启动结果；不会发送聊天消息。
状态检查不再把历史 `poll_health.ok` 当成当前轮询健康：同时显示健康年龄、
正在运行的轮询、闹钟时间和最近闹钟结果。停滞且已到期的闹钟重新唤醒；
正在运行的轮询和短期重试时间保持不变。闹钟异常显式记录并安排 30 秒后恢复，
收到入站消息时仅记录接收时间，不在状态接口暴露消息正文。
https://developers.cloudflare.com/changelog/post/2026-10-30-durable-objects-deferred-code-updates/
