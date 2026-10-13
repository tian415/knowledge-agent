# 贡献与验证

当前是个人维护的原型，暂不承诺响应时效。提交问题时附最小合成复现、Node/系统版本和预期行为；不要附真实聊天、笔记、配置或密钥。

```bash
npm ci --ignore-scripts
npm test
npm run demo:product
```

变更应保留：原文 UTF-8 字节身份、partial 非删除、人工反馈优先、来源失效、预览哈希确认、路径保护、幂等写入和受控恢复。测试使用临时私有目录，不运行真实 Vault 实验。

设计取舍见 [架构](docs/architecture.md)。新增能力应明确合成验证与真实使用验证的区别。
