# dsh-session-cost

DSH（DeepSeek Harness）插件：在 Web GUI 底部统计条里显示**当前会话的 DeepSeek API 费用估算**。

效果：统计条末尾多出一项 `费用 ≈¥0.35`，悬停可见明细（缓存命中 / 未命中 / 输出 三部分费用）。

![效果截图](docs/screenshot.png)

## 安装

```bash
dsh plugin add dsh-session-cost
```

（`dsh` 未全局安装时：`npx --yes @deepseek-ai/dsh plugin --profile web add dsh-session-cost`）

安装后**重启 `dsh web` 生效**。

## 怎么算的

- 数据源：DSH 的 `tokenUsage` 会话投影（官方 `dsh-token-meter` 提供，与统计条同源）：`uncachedInputTokens` / `cacheReadTokens` / `cacheWriteTokens` / `outputTokens`
- 计费口径（对应官方账单）：缓存**写入**按"未命中"单价计
  `费用 = (未命中 + 写入) × miss单价 + 命中 × hit单价 + 输出 × out单价`
- 价格：官方 https://api-docs.deepseek.com/zh-cn/quick_start/pricing

| 模型 | 百万输入（命中） | 百万输入（未命中） | 百万输出 |
| --- | --- | --- | --- |
| deepseek-v4-flash（2026-08-17 前） | ¥0.02 | ¥1 | ¥2 |
| deepseek-v4-pro（2026-08-17 前） | ¥0.025 | ¥3 | ¥6 |
| deepseek-v4-flash · 高峰（9-12/14-18 北京时间） | ¥0.10 | ¥3 | ¥9 |
| deepseek-v4-flash · 空闲 | ¥0.05 | ¥1.5 | ¥4.5 |
| deepseek-v4-pro · 高峰 | ¥0.30 | ¥9 | ¥27 |
| deepseek-v4-pro · 空闲 | ¥0.15 | ¥4.5 | ¥13.5 |

- 2026-08-17 00:00（北京时间）起自动切换峰谷计价；高峰时段自动按北京时间判断

## 说明与限制

- **估算值**：仅供参考，与实际账单可能有出入（缓存写入归入未命中的口径、模型切换、四舍五入）
- **模型**：v1 按 `deepseek-v4-flash` 计（会话中途切换模型不追溯）；要改默认模型/价格，编辑 `lib/client.js` 顶部的 `DEFAULT_MODEL` 与价格表
- 显示"≈"标记表示估算

## 开发者

- 仓库：https://github.com/ChengChe106/dsh-session-cost
- 协议：MIT
