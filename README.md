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

## 安装（可移植，任意路径/服务器）

本插件**零机器耦合**：代码里没有任何硬编码用户/路径，外部依赖仅 `curl`（基本所有
Linux/macOS 都有）。`dshApi`、`usdRate`、`peakHours`、`pricing` 全部走 profile 行的
config，安装脚本会自动探测目标 DSH 的地址，不写死任何路径。

DSH profile 目录：`$DSH_HOME/profiles/<id>/`（默认 `$DSH_HOME=$HOME/.dsh`）。

### 方式 A：用安装脚本（推荐）

把整个目录或发布包放到目标服务器任意路径，然后执行：

```bash
# 直接运行（自动探测 profile、自动探测 DSH API 端口）
./install.sh

# 指定 profile / 覆盖 DSH 后端地址
./install.sh --profile web --dsh-api http://127.0.0.1:3080

# 可选：写入汇率 / 高峰时段 / 价格表
./install.sh --usd-rate 7.1 --peak-hours '[[9,12],[14,18]]' --pricing '{"deepseek-v5":{...}}'

# 先看会改什么，不实际写
./install.sh --dry-run
```

`install.sh` 会（幂等）：① 把本插件 链接/复制 进
`<profile>/node_modules/dsh-session-cost`；② 若 `cordis.patch.yml` 还没有该行则追加带
自动探测 `dshApi` 的 insert 行；③ 提示重启 DSH。在另一台机器`不同路径`/`不同 profile`
上用 `--profile` 指定即可，无需改任何文件内容。

### 方式 B：npm 安装（发布包自包含）

把 `dsh-session-cost-0.1.0.tgz` 拷到目标机，按普通 npm 包装进 profile：

```bash
cd <profile>/node_modules
npm install /path/to/dsh-session-cost-0.1.0.tgz   # 若全局装则装到 node 全局
```

随后执行生成的命令（自动走同款探测逻辑）：

```bash
install-dsh-session-cost --profile web
```

仍会往对应 `cordis.patch.yml` 追加 insert 行，然后**重启 DSH**。

### 重启后使用

`session_cost` 工具即插即用，见下方「使用」。

## 使用

- `session_cost`（不带参数）→ 最近 N 个会话的费用总览（tokens + ¥ + $）。
- `session_cost { "sessionId": "session-xxx" }` → 单会话明细：按计费桶
  （输入未命中 / 输入命中 / 输出）× 峰/谷拆分。

## 配置

| 键 | 说明 | 默认 |
|---|---|---|
| `dshApi` | DSH 后端地址（install.sh 自动探测，或 `--dsh-api` 覆盖） | `http://127.0.0.1:3080` |
| `usdRate` | 人民币兑美元汇率（CNY/USD） | `7.1` |
| `peakHours` | 北京时间高峰时段 `[[起, 止), …]` | `[[9,12],[14,18]]` |
| `pricing` | 追加/覆盖模型价格（与内置表同构） | `{}` |
| `overviewLimit` | 总览最多会话数 | `8` |

价格变动时改 `pricing` 覆盖即可；内置表在插件版本升级时更新。
