# Clawdbot 异步 Agent SOP

这份文档总结了一套可复用的思路：让 Clawdbot 在聊天里自然接收“后台启动 / 状态 / 日志 / 继续 / 停止”指令，同时保持前台会话不被长任务阻塞。

适用场景：

- 想让 QQ / Discord / WhatsApp 里的主会话继续聊天
- 想把长任务丢给 Codex 或其他工具型 agent 在后台执行
- 想随时轮询状态、查看摘要日志、继续任务或停止任务

---

## 一句话设计

把 `main` 设计成控制面，把真正的长任务放进独立后台 agent。

- 前台 `main` 只负责：
  - 识别自然语言控制命令
  - 调用异步 helper
  - 返回 `jobId`、状态、下一步可发送的话术
- 后台 async agent 只负责：
  - 真正执行任务
  - 保持独立会话上下文
  - 把状态、日志、结果写到磁盘

核心原则：前后台分离，控制面和执行面分离。

---

## 为什么这样做

如果直接让主会话执行长任务，会遇到这些问题：

- 前台聊天被阻塞
- 长任务和聊天上下文混在一起
- 没法优雅地“继续上次那个任务”
- 没法明确查看某个后台任务的状态和日志
- 任务失败后很难定位问题

把每个后台任务做成独立 job + 独立 agent 后，上述问题会自然缓解。

---

## 推荐架构

推荐分成三层：

### 1. 聊天控制层

由 `main` 负责理解自然语言：

- `后台启动 arboris-codex：<任务>`
- `后台列表`
- `后台列表全部`
- `后台状态 <jobId>`
- `后台日志 <jobId>`
- `后台继续 <jobId>：<任务>`
- `后台停止 <jobId>`

这一层不执行长任务，只把自然语言翻译成确定性的 helper 命令。

### 2. 异步 helper 层

提供一个稳定的命令行接口，例如：

- `start`
- `status`
- `logs`
- `send`
- `stop`

建议保持参数简单、确定、可脚本化。

### 3. 后台 worker 层

每个 job 一个独立 worker/agent，负责：

- 读取排队任务
- 调用目标 agent
- 持久化运行结果
- 更新状态
- 支持停止信号

---

## 最重要的几个设计决定

### 1. 一任务一 agent

不要把所有后台任务都塞进同一个长寿命后台会话。

建议每个 job：

- 创建独立 agent
- 使用独立 session
- 拥有独立状态目录

好处：

- 不污染其他任务上下文
- 方便继续 / 停止 / 删除
- 日志和结果天然隔离

### 2. 自然语言必须先识别成控制命令

像这类输入：

`后台启动 arboris-codex：请分析这个项目并给出优化方案`

`main` 必须先识别出：

- 这是控制命令，不是普通聊天请求
- 真正任务是冒号后面的 payload
- payload 必须丢到后台 job，而不是在当前前台直接执行

这是最关键的一条。

### 3. `jobId` 是整个系统的主键

所有后续动作都围绕 `jobId`：

- 查状态
- 查日志
- 继续任务
- 停止任务

因此 `start` 的返回里必须稳定返回 `jobId`。

### 4. 默认日志看摘要，不看原始洪水

`后台日志 <jobId>` 默认应该返回：

- 当前 state
- 最近结果摘要
- 最近事件流
- 是否有错误

除非用户明确要原始日志，否则不要直接把完整日志倒回聊天界面。

### 5. `后台列表` 默认只看活跃任务

默认列表建议只返回：

- 正在运行
- 正在排队
- 尚未清理的活跃 job

历史任务单独放到：

- `后台列表全部`

否则会越来越吵。

---

## 命令面推荐接口

一个够用的最小集合：

### `start`

创建后台 job：

- 新建 async agent
- 创建状态目录
- 写入首个任务
- 拉起 worker
- 返回 `jobId`

### `status`

支持两种模式：

- `status --job-id <id>`：查看单任务
- `status`：查看活跃任务列表
- `status --all`：查看全部任务

### `logs`

查看单任务摘要日志：

- 最近事件
- 最新结果
- 最新 run 的输出尾部
- worker stderr 尾部

### `send`

向已有 job 追加下一条任务：

- 不新建 job
- 不切换上下文
- 继续沿用同一个后台 agent

### `stop`

停止任务并可选清理：

- 写停止信号
- 等待 worker 退出
- 可选删除 async agent
- 返回最终状态

---

## 目录与数据落盘建议

推荐每个 job 单独目录，例如：

```text
.async-codex/<jobId>/
  job.json
  events.jsonl
  queue/
  runs/
  worker.out.log
  worker.err.log
  worker.pid
  stop.signal
```

建议保存：

- `job.json`：当前状态快照
- `events.jsonl`：事件流
- `queue/`：待执行任务
- `runs/`：每次执行的 request/result/raw

这样可以非常容易地实现：

- 轮询状态
- 追溯结果
- 排障
- 事后复盘

---

## 状态字段建议

至少要有这些字段：

- `jobId`
- `agentId`
- `baseAgent`
- `workspace`
- `model`
- `state`
- `workerPid`
- `workerAlive`
- `queueCount`
- `completedCount`
- `failedCount`
- `currentTask`
- `lastResultPreview`
- `lastError`
- `createdAt`
- `updatedAt`
- `lastCompletedAt`

这些字段足够支持绝大部分前台展示和轮询需求。

---

## 自然语言映射建议

推荐把自然语言固定映射到 helper 命令：

- `后台启动` -> `start`
- `后台列表` -> `status`
- `后台列表全部` -> `status --all`
- `后台状态` -> `status --job-id`
- `后台日志` -> `logs --job-id`
- `后台继续` -> `send`
- `后台停止` / `后台关闭` -> `stop --wait --delete-agent`

前台回复建议统一包含：

- `jobId`
- 使用的 agent
- 当前 state
- 下一步可以直接发的控制语句

这会极大降低用户学习成本。

---

## 容器化场景下的关键经验

如果 Clawdbot 是跑在 Docker 容器里，要牢记：

### 1. 聊天里的 `exec` 看到的是容器，不是宿主机

这意味着：

- 宿主机 PowerShell 脚本在你本机能跑
- 不代表聊天里的 `exec` 工具也能调用到

所以真正要给聊天控制层使用的 helper，必须放在：

- 容器内可见路径
- 最好是 bind mount 进去的工作区路径

### 2. 优先改挂载目录，不要先改镜像源码

在这类部署里，优先改：

- `openclaw-data/...`

不要先改：

- `openclaw-src/...`

因为很多时候运行中的容器根本没在用你本地源码树。

### 3. 不是每次都要重建 Docker

经验规则：

- 改挂载脚本 / 提示词：通常立即生效
- 改运行配置：通常重启容器即可
- 改镜像内代码 / Dockerfile / 依赖：才需要重建镜像

---

## 两个非常容易踩的坑

### 坑 1：新 async agent 被 `BOOTSTRAP.md` 带偏

如果工作区里有：

- `BOOTSTRAP.md`
- onboarding / identity 类提示

新建后台 agent 首轮可能先开始“自我介绍 / 询问身份”，而不做真正任务。

解决方式：

- worker 在真正发送给后台 agent 的消息外面包一层系统化前缀
- 明确说明这是内部异步工作会话
- 明确要求跳过 bootstrap / onboarding
- 让 agent 静默遵守工作区规则并直接执行任务

这是后台系统能否稳定工作的关键修复点。

### 坑 2：长文本穿过多层 shell 很容易损坏

任务内容里只要有：

- 引号
- 换行
- 冒号
- 多段文本

就很容易被宿主 shell / docker exec / 容器 shell 某一层吃掉。

解决方式：

- 支持 `--message-file`
- 长任务先写临时文件
- 再把文件内容交给 helper

这比硬拼引号稳得多。

---

## 前台回复模板建议

### 启动成功

```text
已启动后台任务。

- jobId: xxx
- agent: arboris-codex
- state: queued

后续可直接发：
- 后台状态 xxx
- 后台日志 xxx
- 后台继续 xxx：你的新任务
- 后台停止 xxx
```

### 状态查询

```text
- jobId: xxx
- agent: arboris-codex
- state: idle
- completed: 1
- lastResult: ...
```

### 日志查询

```text
- jobId: xxx
- state: idle
- latestResult: ...
- recentEvents: job.created → worker.started → task.started → task.completed
- errors: none
```

### 停止成功

```text
- jobId: xxx
- agent: arboris-codex
- state: stopped
- workerAlive: false
- agentDeleted: true
```

---

## 实施顺序建议

如果要在另一个 Clawdbot 上复用，推荐按这个顺序做：

1. 确认 `main` 是否拥有 `exec` 等工具
2. 在容器可见路径放好 helper CLI
3. 先把 `start/status/send/stop` 跑通
4. 再补 `logs`
5. 再把自然语言规则写进工作区提示
6. 最后做端到端验证：
   - 后台启动
   - 后台列表
   - 后台状态
   - 后台日志
   - 后台继续
   - 后台停止

不要一开始就直接押注“模型会自己懂”。

---

## 判断是否成功的验收标准

以下几项最好全部满足：

- 主会话发“后台启动”后不会卡住长时间工作
- 能稳定拿到 `jobId`
- 能用 `后台状态` 看到进度或结果
- 能用 `后台日志` 看到摘要信息
- 能用 `后台继续` 续跑同一个后台 job
- 能用 `后台停止` 停掉并清理任务
- 后台 agent 不会被 bootstrap/onboarding 带偏
- 长任务文本不会因引号和换行而损坏

---

## 可直接复用的经验总结

如果只记一句话，记这个：

> 在 Clawdbot 上做异步能力时，不要让 `main` 直接干长活；让 `main` 只做控制，让独立 async agent 干活，并把一切都围绕 `jobId`、状态持久化和自然语言控制命令来设计。

---

## 本次实现参考

这次落地的关键文件：

- `openclaw-data/clawdbot/workspace/AGENTS.md`
- `openclaw-data/clawdbot/workspace/TOOLS.md`
- `openclaw-data/clawdbot/workspace/async-codex/cli.mjs`
- `openclaw-data/clawdbot/workspace/async-codex/lib.mjs`
- `openclaw-data/clawdbot/workspace/async-codex/worker.mjs`

如果你要迁移到别的 Clawdbot，优先复制的是思路，不是字面实现。

---

## 多端同步与多系统接入说明

面向普通用户时，建议把系统拆成三层：

- **单一控制面**：只保留一个主 Gateway / 主 brain，负责接收自然语言指令、汇总状态、分发任务
- **设备执行面**：每台手机绑定一个长期存活的 subagent / worker / session，负责真正的运营动作
- **多端观察面**：Web、Windows、macOS、Linux CLI 只是不同入口，连到同一个 Gateway，看的是同一份任务状态

核心原则：

- 手机和 brain 绑定，而不是和当前聊天窗口绑定
- 前台聊天窗口只是控制台，不是执行上下文本身
- 所有端都读写同一份 job / worker / phone registry
- 同一台手机同一时刻只能有一个活跃 worker 持有控制权

### 推荐同步模型

推荐把以下信息都做成 Gateway 侧的单一真源：

- `phones.json` 或等价 registry：记录手机 ID、别名、平台、在线状态、最近截图、当前任务
- `workers.json` 或等价 registry：记录 workerId、绑定 phoneId、当前 state、最近心跳、当前 runId
- `jobs.json` 或等价 registry：记录主任务、子任务、进度、最近结果摘要、最后错误
- `events.jsonl`：记录可审计事件流，供 Web / macOS / Linux 统一展示

这样多端同步时不需要互相传上下文，只需要：

- 前台发控制命令
- Gateway 更新状态
- 观察端订阅状态变化

### macOS / Linux / Windows 的接入方式

建议统一按“同一 Gateway，不同客户端”来接：

- **Web / Control UI**：给普通用户做主入口，负责查看所有手机、任务、最新截图、最新回执
- **Windows**：适合作为开发与 Docker 宿主，连本地 ADB、跑控制 UI、跑本地验证链路
- **macOS**：适合接入 Clawdbot Mac app、语音、Canvas、桌面通知，也可以作为运营总控台
- **Linux**：适合作为长期在线的 Gateway / worker 宿主，跑 cron、守护进程、多手机调度

不要把不同系统做成不同脑子；应该是：

- 一个主脑
- 多个设备 worker
- 多个观察/控制客户端

### 多端同步时必须保证的约束

至少要保证下面这些约束，否则后面一上量就会乱：

- 同一 `phoneId` 只能被一个 active worker 锁定
- 主会话改派任务时，必须向原 worker 发送中断 / 切换信号，而不是再起一个新 worker 抢手机
- 所有端显示的“当前任务 / 最近截图 / 最近动作 / 最近错误”都来自同一份状态源
- 截图、回执、阶段摘要要做缓存与 TTL，避免 Web 和多端轮询把上下文打爆
- 主会话只拿摘要，不吞子 agent 全量流式内容

### 推荐展示给普通用户的最小信息

不管以后是网页、macOS 还是 Linux TUI，建议每台手机至少展示：

- `phoneId`
- `displayName`
- `platformHost`（windows/mac/linux）
- `workerState`
- `currentGoal`
- `lastAction`
- `lastScreenshotAt`
- `lastHeartbeatAt`
- `lastError`

这样用户在 QQ / Web / 控制台任一入口里，都能快速知道：

- 哪台手机在线
- 正在做什么
- 卡在哪一步
- 是否需要人工接管

### 后续落地顺序

如果要继续往产品化推进，推荐顺序是：

1. 先把单 Gateway + 单手机 + 单 worker 跑稳
2. 再把 `phone registry / worker registry / job registry` 固化
3. 再做 Web 总览页和统一状态订阅
4. 再接 macOS / Linux 观察端
5. 最后再做多手机并发调度、定时任务、用户权限隔离

先把状态单一真源做稳，再谈多端、多手机、多用户。
