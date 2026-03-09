# Yunying

`yunying` 是一个面向手机运营场景的后台编排插件：

- 一个手机对应一个后台任务上下文
- 一个手机对应一个长期存在的 `workerSessionKey` / brain session
- 前台对话只负责下达目标
- 后台按 `*.skill.json` 的阶段定义逐段执行
- 同一手机收到新目标时，可以用 `replace` 中断旧任务并切换
- 手机可以单独命名，方便前台总览和自然语言调度

## 固化操作

把运营 SOP 写成 `skills/*.skill.json`：

- `platform`：平台标识，例如 `xiaohongshu`
- `stages[]`：阶段列表
- `actions[]`：当前阶段必须做的动作
- `completionCriteria[]`：当前阶段什么时候算完成
- `risks[]`：风控与账号安全约束
- `defaults.repeatIntervalMs`：可选，阶段全部完成后多久再次自动唤起同一手机 worker

内置示例：

- `extensions/yunying/skills/xiaohongshu-daily-operations.skill.json`

## 前台会话里的典型调用意图

- 先让模型查看技能：`列出当前 yunying skills`
- 开始任务：`根据 xiaohongshu-daily-operations skill，帮我开始今天的小红书运营`
- 替换任务：`手机1不要跑小红书了，改成大众点评运营`
- 命名手机：`把这台手机命名为小红书1号机`
- 问后台脑：`让手机1的后台脑总结当前策略`
- 看全局总览：`查看所有手机当前状态`
- 查状态：`查看 work 手机当前 yunying 状态`
- 查日志：`把当前手机 yunying 最近日志发我`

## 本地配置

插件配置放在：

- `plugins.entries.yunying.enabled`
- `plugins.entries.yunying.config.defaultAccountId`
- `plugins.entries.yunying.config.skillsDir`

运行状态会落到：

- `~/.clawdbot/plugins/yunying/`

其中关键文件现在分为：

- `jobs/*.json`：任务主状态
- `jobs/*.jsonl`：运行事件日志
- `devices/*.json`：设备占用与最近状态
- `workers/*.json`：长期 worker 状态、命名结果、稳定 `workerSessionKey`、心跳、下次唤起时间
- `artifacts/<jobId>/_summary.json`：任务终态/恢复摘要
- `artifacts/<jobId>/<stageId>.json`：阶段产物、runId、runtime 事件摘要

每台手机还会绑定一个真实的 session transcript brain：

- 使用稳定 `workerSessionKey` 作为同一手机的长期脑标识
- 关键阶段进展会被压缩写入 transcript，供后续 `brainSend` / 状态总览读取
- brain transcript 是“长期记忆镜像”，真正的执行状态仍以 `workers/*.json`、`jobs/*.json` 为准

后台 supervisor 会随插件一起启动：

- 自动扫描 `nextWakeAt` 到点的 worker
- 对可恢复的中断任务自动 `resume`
- 对配置了 `defaults.repeatIntervalMs` 的 skill 自动再次唤起
- 把长期状态继续压缩写回 `workers/*.json`

## 当前实现边界

- `src/control-plane.ts`：前台入口、调度、fleet/status/logs
- `src/brain.ts`：每台手机的真实 session/transcript brain 绑定与摘要读取
- `src/worker.ts`：每台手机的后台执行循环、stop/replace、恢复清理
- `src/runtime.ts`：PhoneManager 适配与 runtime 事件标准化
- `src/store.ts`：job/device/artifact 持久化

当前重启与自动续跑策略是：

- 若网关重启后发现磁盘里有 `running/accepted` 任务但进程内已无活跃 worker，会把旧任务标记为 `failed`
- 同时写入 `job.recovered_stale` 日志、恢复摘要和当前阶段的 `recovered_stale` 产物
- 对可恢复场景（如 stale recovery、context overflow、timeout、rate limit、临时上游错误）会安排 `nextWakeAt` 并由 supervisor 自动续跑剩余阶段
- 对显式 `stop` / `replace`、鉴权错误、账单错误、格式错误不会自动续跑
