# P2 A 端交付记录：Codex 非交互适配器

## 实现

`packages/codex-adapter/` 提供：

- 固定生成 `codex exec --json --ephemeral --sandbox <mode> <prompt>` 参数。
- 默认 `read-only` 沙箱；任务明确需要改文件时才传入 `workspace-write`。
- JSONL 事件解析、thread ID、最终 agent 消息、事件计数和 stdout/stderr SHA-256 摘要。
- 登录过期、配额不足、限流、非零退出、超时和非法 JSON 的分别归类。
- 子进程使用参数数组和 `shell: false`，不拼接 shell 字符串。
- 不读取、打印或保存 API key、access token、`auth.json` 或原始会话日志。

实现依据官方 OpenAI 文档的 `codex exec`、`--json`、`--ephemeral` 和显式 sandbox 约定；官方文档还说明 JSONL 事件写到 stdout，进度写到 stderr。

## 实际验证

- `codex --version`：实际输出 `codex-cli 0.135.0`
- 适配器离线测试：3 个测试通过，覆盖参数、完成 JSONL、登录和非法 JSON 分类
- 根项目 `npm run check`：7 个测试文件、79 个测试全部通过；协议 5 个样例通过
- 真实最小调用：`codex exec --json --ephemeral --sandbox read-only "Reply with exactly READY"` 已启动并输出 `thread.started`、`turn.started` 和 JSONL 错误事件

真实调用尚未成功完成：第一次受当前沙箱阻止，第二次提升本机网络权限后仍在连接 `api.openai.com` 时超时；没有出现登录提示。因此不能写成“真实 Codex 联调通过”，也没有索取或记录任何凭据。

## 下一步

网络可用后，重试同一个只读最小调用；若 CLI 明确返回登录要求，再由用户在本机完成登录。随后再做一次 `workspace-write` 受控任务和结果报告回传测试。推送、CI、Cloudflare、数据库和部署仍未执行。
