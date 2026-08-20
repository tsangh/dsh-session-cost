# dsh-session-cost

每会话 DeepSeek API 费用工具（`session_cost`）。读取会话日志里真实的计费 token 用量
（`assistant/message` 事件的 `usage` 记录），按 DeepSeek 官方「峰谷计价」schema 计价。

## 定价 schema（官方，2026-08-20 抓取）

来源：[DeepSeek API 文档 · 模型 & 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)

- 计价货币：人民币（CNY），每百万 tokens。
- **高峰时段（北京时间）**：09:00–12:00、14:00–18:00；其余为空闲时段，**价格为高峰一半**。

| 模型 | 输入·缓存未命中 (高峰/空闲) | 输入·缓存命中 (高峰/空闲) | 输出 (高峰/空闲) |
|---|---|---|---|
| `deepseek-v4-flash` | ¥3.00 / ¥1.50 | ¥0.10 / ¥0.05 | ¥9.00 / ¥4.50 |
| `deepseek-v4-pro` | ¥9.00 / ¥4.50 | ¥0.30 / ¥0.15 | ¥27.00 / ¥13.50 |

USD 按可配置汇率折算（默认 7.1 CNY/USD）；DeepSeek 按人民币结算，权威金额以
[DeepSeek 开放平台](https://platform.deepseek.com) 的用量账单为准。

## 安装

1. 链接到 profile 的 node_modules：

   ```bash
   ln -s /home/eric/CodingProject/dsh/plugins/dsh-session-cost \
         /home/eric/.dsh/profiles/web/node_modules/dsh-session-cost
   ```

2. 在 `/home/eric/.dsh/profiles/web/cordis.patch.yml` 追加：

   ```yaml
   - insert:
       - id: session-cost
         name: 'dsh-session-cost'
         config:
           dshApi: http://127.0.0.1:3080
           usdRate: 7.1
   ```

3. 重启 DSH。

## 使用

- `session_cost`（不带参数）→ 最近 N 个会话的费用总览（tokens + ¥ + $）。
- `session_cost { "sessionId": "session-xxx" }` → 单会话明细：按计费桶
  （输入未命中 / 输入命中 / 输出）× 峰/谷拆分。

## 配置

| 键 | 说明 | 默认 |
|---|---|---|
| `dshApi` | DSH 后端地址 | `http://127.0.0.1:3080` |
| `usdRate` | 人民币兑美元汇率（CNY/USD） | `7.1` |
| `peakHours` | 北京时间高峰时段 `[[起, 止), …]` | `[[9,12],[14,18]]` |
| `pricing` | 追加/覆盖模型价格（与内置表同构） | `{}` |
| `overviewLimit` | 总览最多会话数 | `8` |

价格变动时改 `pricing` 覆盖即可；内置表在插件版本升级时更新。
