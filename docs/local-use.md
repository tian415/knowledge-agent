# 本地使用边界

先通过 [合成演示](demo.md) 理解流程。真实使用涉及自己的来源和笔记，不是首次体验的必要条件。

## 默认入口

`npm start` 和 `npm run demo:product` 启动隔离合成演示。`npm run demo` 是较早的材料输入演示，同样使用临时目录和模拟 Provider。

## 配置驱动的主题工作台

命令入口为 `scripts/knowledge-workspace.mjs`。先使用 `doctor --config` 检查自己的绝对配置路径，再用 `status --config` 或 `serve --config`；CLI 当前没有 `--help`。CLI 使用显式配置，来源目录、项目白名单、私有 Store 和笔记目标均需由使用者指定。请先运行配置检查，保持 `preview-only`；启用 confirmed 模式后仍须逐次确认具体计划。完整参数以该 CLI 的参数解析和 `src/capture/setup.mjs` 为准；不要把合成 runtime 当作正式来源配置。

真实 Codex 来源仅限配置范围；ChatGPT 内容由已授权助手工具提供，本服务不独立登录账号。语义分析不会因启动网页自动发生。处理预算不是 token 或费用硬上限。

## 旧材料入口

`npm run intake:serve` 启动较早的材料服务，**不是合成演示**。在用户提交材料、配置 Provider 且 Registry 可用时，它会把材料发给已配置的 DeepSeek 服务，可能产生费用。不要为了体验主流程启动它。

密钥仅从环境读取：`DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL`；可选 `DEEPSEEK_BASE_URL`。代码不加载 `.env`。Registry 默认位置为 `~/Documents/KnowledgeVault` 和 `~/Projects`；可通过 `KNOWLEDGE_AGENT_VAULT_ROOT`、`KNOWLEDGE_AGENT_CODE_ROOT` 指定，项目覆盖配置为 `config/registry-overrides.json`。公开包提供空配置，不包含作者的个人绑定。旧入口仍需匹配的 `.project-knowledge/config.json`，不宣称免配置可用。

## 可选能力

离线执行器演示 `npm run demo:executor` 使用固定本地假进程；不会启动真实模型。检索集成需要独立配置 Python/Basic Memory，默认关闭，本次未重新验收其外部依赖。

## 数据保护

私有状态与 Vault 必须放在源码目录之外，不用符号链接绕过限制。不公开 raw、attempts、来源账本或真实预览。状态损坏或结果不明时保留现场，先核对记录；不清锁、不自动重试。
