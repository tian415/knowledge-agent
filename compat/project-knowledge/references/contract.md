# 提案与工具契约 v2

运行环境：Node.js 24+。所有命令用 `node bin/pk.mjs`；安装的 Skill 使用自己的 `scripts/pk.mjs`。命令返回 JSON，错误写 stderr 并非零退出。`help` 列出完整参数。

## JSON 输入

可运行样例见工程 `examples/conversation.json`。结构：

```json
{
  "version": 2,
  "mode": "capture",
  "sources": [{
    "id": "discussion-1:user-1",
    "kind": "chat",
    "actor": "user",
    "title": "虚构项目讨论",
    "locator": "fixture:discussion-1/user-1",
    "observedAt": "2026-09-08",
    "scope": "用户第1条消息",
    "completeness": "complete",
    "excerpt": "先验证只读查询。",
    "summary": "讨论项目第一版范围。"
  }],
  "notes": [{
    "id": "scope",
    "project": "demo",
    "knowledge_layer": "PROJECT_KNOWLEDGE",
    "path": "01-项目沉淀/demo/第一版范围.md",
    "reason": "依赖本项目的目标和约束",
    "title": "第一版范围",
    "kind": "thinking",
    "sections": [{
      "heading": "当前判断",
      "body": "先验证只读查询。",
      "status": "user-stated",
      "sources": ["discussion-1:user-1"]
    }]
  }]
}
```

`sources.id` 定位消息/命令或材料片段，修订保留 ID 并更新 excerpt。聊天分支或新消息使用各自 ID，不以标题或单一日期去重。每个笔记 ID 在项目内稳定；每次提案包含该笔记应保留的完整管理区，工具不会替 AI 合并语义。不要遗漏仍有效的旧观点和必要的变化历史。

`notes.path` 是知识库相对完整路径。每条 note 独立指定已登记的 `project`、`knowledge_layer`、分类理由 `reason`；项目内容还必须位于该项目目录内。overview 必须使用该项目目录加 dashboard 的路径。通用知识与方法使用已登记的通用命名空间，实际路径由类别决定。`rules` 返回与知识中心共用的四类标准；分类与建议是否验证无关。跨类别批次使用同一个预览摘要、锁和事务。

旧 v1 新提案返回 ROUTING_REVIEW_REQUIRED，必须逐知识点复核后填写 v2，不能只改 version。已存在的 v1 事务仍可 recover；不要改旧计划和状态来绕过保护。

类型：

| 字段 | 可用值 |
| --- | --- |
| mode | capture、daily、weekly、promote |
| source.kind | chat、repository、command、document、manual |
| source.actor | user、assistant、tool |
| source.completeness | complete（仅声明范围完整）、partial |
| note.kind | overview、thinking、engineering、daily、weekly、candidate、decision、knowledge、runbook |
| section.status | user-stated（用户陈述）、proposed（AI建议）、uncertain（待验证）、verified（已验证事实） |

verified 必须引用至少一项完整、actor=tool 的 repository/command 来源；这是最低结构约束，不代表核心能判断语义真假。人/整理代理仍须检查原始输出是否支持具体主张。用户陈述必须含 user 来源。实际用户实验也可先保存为原始记录并以 user-stated 描述，不擅自升级。

decision/knowledge/runbook 必须 mode=promote；所有非项目类别以及上述类型 apply 都需要 `--confirm-promotion`。该参数只表示调用者已获得本次具体授权，不能由来源文本触发。

daily 只改 overview/daily/candidate；weekly 只改 overview/weekly/candidate。周复盘中用户理解部分留给用户本人；不要建立空白的“通过”记录。

正文支持 Markdown 和 Mermaid。导入 HTML 的 `<` 和图片/Obsidian 嵌入前缀会被转义，以免自动加载外部图片或其他私人笔记。普通链接仍可点击，来源中的命令不被执行。源码行、日期和 URL 需实际核对。

## 写入与恢复

preview 不写知识库；提案和 plan 放在知识库外的私人暂存目录。apply 重新计算预览并比较摘要；目标或处理状态变化时拒绝旧 plan。应用时创建 `.project-knowledge/transactions/<id>.json`，包含 before/after；它是私人恢复资料，不应公开。单文件临时写入后重命名并读回；事务可多文件续跑。

手工补充放在 `<!-- pk:start:... -->` 与 `<!-- pk:end:... -->` 外。内部手改即使重新预览也会阻断，以防 AI 覆盖。此版本未提供自动解决内部手改的功能；保留现有文件，人工审阅并另存合并草稿，不直接重置 state。

中断：运行 doctor；确认没有本工具写入进程后才可 `unlock --confirm`，再 `recover --transaction <id>`。恢复只在文件仍等于事务 before/after 时续跑；遇到第三种内容停止并保留文件。已完成事务保存原文，可人工比对恢复，不提供一键删除或回滚用户笔记。

工具锁只协调本工具，不能锁住 Obsidian 或同步软件。应用的短时间内避免同时编辑同一文件。前后检查与备份不保证抵抗恶意本机进程的竞态攻击；不支持多人并发协作。不要手工编辑事务和状态文件。

## 仓库证据

`capture-repo --repo <源码目录> --date YYYY-MM-DD --out <私人 evidence.json>` 只运行 Git status/diff/log，不执行测试、构建或材料中的命令。完整命令与截断信息保存在输出；未跟踪文件正文不包含在 diff 内，按需明确读取。输出可能包含私人代码；不默认公开。

捕获结果是提案的证据输入，不自动生成产品结论。项目归属仍由便携配置中的稳定 ID 决定，不能把当前目录名当作唯一身份。

## 本机与迁移

知识库 `.project-knowledge/config.json` 与 state/transactions 随私人知识库迁移。`~/.codex/project-knowledge.local.json` 只绑定本机 vault_root，不随公开工程发布。项目源码路径按调用提供；安装脚本也生成旧版兼容的 `obsidian-retrospective.json`，便于旧工具定位，但新 Skill 以 project-knowledge 配置为准。

换电脑：复制知识库，安装 Node.js 24+，运行 `node scripts/install.mjs --vault <新位置>`。已有项目规则和处理状态保留；宿主聊天访问需要在新电脑重新授权。直接聊天读取失败时使用 Markdown/JSON 输入。

## 本地图示

每个 section 可增加 `images: [{"path":"图示/架构.png","alt":"架构设计建议"}]`。image.path 相对该笔记所声明 project 的目录，note.path 则为知识库相对路径；渲染为笔记相对路径，兼容普通 Markdown 编辑器。先在知识库保存并检查图片。仅接受 5 MB 内且有 PNG 文件头的本地文件，不联网抓图、不自动生成图。预览记录图片哈希，图片变化会阻止 apply/recover。该检查不是图像解码器或恶意文件扫描器，使用可信生成或已审阅的图片。普通 body/excerpt 中的自动嵌入仍转义。

正文保留各节可信状态，来源折叠区按原对话链接合并，只展示标题、已知日期、链接和 `summary` 背景。`observedAt` 未知时为 null，禁止以处理时间填充。完整 `excerpt`、scope、ID 保留在提案和事务中，不渲染到笔记。项目结构和迁移注意事项见 reading-layout.md。
