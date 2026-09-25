# 会话费用统计（dsh-session-cost）

> **个人维护副本** —— 派生自 [ChengChe106/dsh-session-cost](https://github.com/ChengChe106/dsh-session-cost)（MIT）。
> 与上游 0.1.3 的差异：flash 单价已按 2026-09-25 官网页面校正（上游仍是调价前的旧值）；高峰时段补上"仅周一至周五"判断。

DSH（DeepSeek Harness）插件：在 Web GUI 底部统计条里显示**当前会话的 DeepSeek API 费用估算**。

效果：统计条下方多出一行 `费用 ≈¥0.35 | 命中 ¥0.28 | 未命中 ¥0.02 | 输出 ¥0.05`，字体与配色完全对齐官方统计条（12px、主题自适应）。

![效果截图](docs/screenshot.png)

## 安装（本地副本，不走 npm）

本副本以 `link:` 方式挂进 DSH profile：

```jsonc
// ~/.dsh/profiles/web/package.json
"dependencies": {
  "dsh-session-cost": "link:I:/Deepseek work/dsh-session-cost"
}
```

`bundles` 数组里登记的仍是 `dsh-session-cost`（包名保持英文，npm 规范不允许中文）。改完在 profile 目录跑一次 `pnpm install`，然后**重启 `dsh web` 生效**。

## 怎么算的

- 数据源：DSH 的 `tokenUsage` 会话投影（官方 `dsh-token-meter` 提供，与统计条同源）：`uncachedInputTokens` / `cacheReadTokens` / `cacheWriteTokens` / `outputTokens`
- 计费口径（对应官方账单）：缓存**写入**按"未命中"单价计
  `费用 = (未命中 + 写入) × miss单价 + 命中 × hit单价 + 输出 × out单价`
- 价格：官方 https://api-docs.deepseek.com/zh-cn/quick_start/pricing

| 模型 | 百万输入（命中） | 百万输入（未命中） | 百万输出 |
| --- | --- | --- | --- |
| deepseek-flash · 高峰 | ¥0.04 | ¥2 | ¥8 |
| deepseek-flash · 空闲 | ¥0.02 | ¥1 | ¥4 |
| deepseek-v4-pro · 高峰 | ¥0.30 | ¥9 | ¥27 |
| deepseek-v4-pro · 空闲 | ¥0.15 | ¥4.5 | ¥13.5 |

- 高峰时段：北京时间**周一至周五**（不含法定节假日）9:00-12:00、14:00-18:00；其余时段（含周末与节假日全天）按空闲计
- 2026-08-17 00:00（北京时间）起自动切换峰谷计价；早于该时刻的用量仍按平峰价（flash ¥0.02/¥1/¥2，pro ¥0.025/¥3/¥6）

## 说明与限制

- **估算值**：仅供参考，与实际账单可能有出入（缓存写入归入未命中的口径、模型切换、四舍五入）
- **模型**：v1 按 `flash` 计（会话中途切换模型不追溯）；要改默认模型或价格，编辑 `lib/client.js` 顶部的 `DEFAULT_MODEL` 与两个价格常量
- **法定节假日未处理**：判断只排除周末，节假日当天仍按高峰算（要正确处理得维护年份表，暂未加）
- 显示"≈"标记表示估算

## 维护

- 本副本目录：`I:\Deepseek work\dsh-session-cost`
- **无构建步骤**：`lib/client.js`（浏览器端：价格表 + 计算 + 组件）和 `lib/index.js`（host 端空操作，只为让 bundle 行能加载）就是源码，直接改
- 上游不定期调价；官方价格页有变动时，改 `lib/client.js` 的 `TIERED_PRICES`（必要时连 `FLAT_PRICES`）即可，改完重启 `dsh web`
- 上游若发新版，用 `git fetch upstream` 对比，别直接覆盖本地改动

## 开发者

- 上游仓库：https://github.com/ChengChe106/dsh-session-cost
- 协议：MIT（版权归原作者 ChengChe106）
