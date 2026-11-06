# dsh-backup · 定时备份

给 DSH 用的备份插件：在 **设置 → 备份** 里配置「多个来源目录 → 一个目标目录」，到点自动打包备份，需要时可以从任意一份备份里恢复。

## 功能

- **定时备份**：每个计划单独设置间隔（5 / 15 / 30 分钟、每小时、每 3 / 6 / 12 小时、每天、每周，也可填任意分钟数）。
- **多来源**：一个计划可以选多个来源目录，全部打进**同一个**压缩包；同名来源目录自动加路径哈希后缀（`docs-1a2b3c`），不会互相覆盖。
- **单目标**：一个计划只写一个目标目录；目标不能等于来源，也不能落在来源内部（否则会无限复制），配置时直接拒绝。
- **两种打包方式**：
  - `ZIP`：走 .NET `ZipFile.CreateFromDirectory`，保留目录结构；单包约 2GB 上限。
  - `TAR.GZ`：跨平台、无 2GB 限制；打包时按 tar 实现自动决定是否加 `--force-local`（GNU 要加，Windows 自带的 bsdtar 不认）。
- **全量备份**：每次运行都完整重打一个包，不做增量，恢复时不用链式依赖。
- **保留份数轮转**：只保留最近 N 份，超出自动删除最旧的。
- **完整性校验**：打完立刻回读压缩包，ZIP 数条目、TAR 列清单，条目为 0 视为失败。
- **排除规则**：逗号分隔，`*` 通配，按路径片段匹配；新建计划默认排除 `.git`，可自行增删。
- **空间预检**：开跑前估算 `来源体积 × 1.05 + 1MB + 计划里的「预留 MB」`，目标剩余空间不足就直接拒绝，不会跑到一半把磁盘写满。
- **暂存目录可配置**：备份时先把文件复制到 `<暂存目录>/<计划 id>`，打包完成（无论成功失败）立刻清空，不留临时文件。暂存目录可在设置页选择，默认 `~/.dsh/backup-stage`；换到大容量盘可以避免系统盘被占用。
- **失败重试**：文件复制遇到 `EBUSY` / `EPERM` / `ETIMEDOUT` / `ECONNRESET` 等瞬时错误自动重试 3 次（400ms、1600ms 退避）。
- **手动备份**：随时点「立即备份」，不受调度影响；运行中可以「停止」。备份在后台执行，**关掉设置页或 DSH 窗口都不会中断**。
- **进度与历史**：备份时能看到已暂存文件数；历史记录保留最近 100 条（时间、结果、大小、耗时、逐条日志）。
- **恢复**：历史里每条成功记录都能恢复，支持覆盖回原目录或指定目录，被占用的文件按策略跳过 / 旁路 / 中止，覆盖前留撤销副本。
- **离线恢复脚本**：一键生成 `run.cmd` + `restore.ps1`，关掉 DSH 后双击运行，脚本会等文件锁释放再覆盖。

## 备份包命名与包内结构

```
<计划名>-<YYYYMMDD-HHmmss>.<zip|tar.gz>
```

例如 `文档-20261106-130803.zip`。计划名里的 `\ / : * ? " < > |` 换成 `_`；时间取本机本地时间，连续数字便于排序。

包内顶层是 `<来源目录名>`（重名时带 6 位路径哈希，如 `docs-1a2b3c`），其下保留相对路径：

```
docs-1a2b3c/readme.md
docs-1a2b3c/sub/one.txt
config/settings.json
```

不会出现 `.` 或 `./` 这类多余的根条目——解压后就是这些顶层目录，不会再套一层。

同一秒内连跑两次时，后一份自动加 `-2`、`-3` 后缀，不会覆盖上一份。

## 恢复

历史表格里状态为「成功」的记录都带「恢复」入口，有两种方式。

### 在线恢复（DSH 运行中，立刻执行）

- **恢复到**留空 = 覆盖回备份时的原始目录；填了目录 = 按包内结构展开到该目录。
- 每个文件独立处理，单个失败不影响其余文件。
- 覆盖前把旧文件复制到 `~/.dsh/restore-undo/<时间戳>/`，恢复错了可以回滚。
- 目标文件被占用时按策略处理：

| 策略 | 行为 |
| --- | --- |
| `skip`（默认） | 跳过被占用的，继续恢复其它文件 |
| `sideload` | 写到旁边 `文件名.restore-<时间戳>`，不动原文件 |
| `strict` | 遇到第一个被占用就整体中止 |

### 离线恢复脚本（DSH 自己占着文件时必须用这个）

点「生成离线恢复脚本」，会写出：

```
~/.dsh/backup-restore/<runId>-<时间戳>/
├── run.cmd        ← 关闭 DSH 后双击
├── restore.ps1    ← 真正执行的脚本（零依赖，只用 PowerShell + 系统 tar.exe）
├── plan.json      ← 恢复计划（备份包、来源映射、策略、等待时长）
└── result.json    ← 跑完之后才有
```

脚本对每个文件轮询独占句柄，默认最多等 600 秒（`plan.json` 里可改 `waitSeconds`），锁一释放就原子替换（先写 `.dsh-restoring` 再 `Move-Item`），不会留半截文件。

跑完把结果写进 `result.json`，下次打开 DSH 的备份设置页会显示「上次离线恢复」。想恢复完自动拉起 DSH，可以在 `plan.json` 里加 `"relaunch": "dsh.exe 的完整路径"`。

## 安装

插件是标准 DSH bundle（`package.json` 的 `dsh.bundle.patch` + `dsh.client`），装进任何 profile 都行。

### 1. 打包件安装（推荐分发）

```bash
dsh plugin add D:\Az\Agent\dsh-backup\dsh-backup-0.4.4.tgz --profile desktop
```

或在 Web 的「插件」页 / `plugin_manager` 工具里用这个 `.tgz` 路径做 `installBundle`。装完 profile 的 `package.json` 会留下对应依赖并自动写进 `dsh.profile.bundles`。

### 2. 本地目录安装（开发用，改代码即生效）

```bash
dsh plugin add link:D:\Az\Agent\dsh-backup --profile desktop
```

### 3. 手工安装

1. 把 `package.json`、`cordis.patch.yml`、`lib/` 放到 `~/.dsh/profiles/<profile>/node_modules/dsh-backup/`
2. 在 profile 的 `package.json` 里把 `dsh-backup` 追加到 `dsh.profile.bundles`
3. 重启 DSH

不需要改 profile 自己的 `cordis.patch.yml`——包自带的 patch 里有 `- insert: [{ id: backup, name: 'dsh-backup' }]`，bundle 层会合进去。

三处（文件在位、bundles 里有名字、包自带 patch）缺一个就静默不生效：设置页不出现，或者出现了但接口全 404。

### 4. 装完必须重启

profile 的 bundle 列表只在启动时合成。运行中热装，本机实测会报 `next is not a function`（任何新 bundle 都一样，换最小探针包也复现），重启后正常。

### 5. 检查装好没有

```bash
curl http://127.0.0.1:<端口>/dsh-backup
# {"ok":true,"config":{...},"plans":[...]}
```

设置页出现在「设置 → 备份」，`order` 排在「定时任务」后面。

## 配置与状态文件

| 用途 | 路径 |
| --- | --- |
| 配置 | `~/.dsh/backup.json` |
| 运行历史 | `~/.dsh/backup-state.json`（最近 100 条） |
| 暂存目录 | `<暂存根目录>/<计划 id>/<来源标签>/<相对路径>`，根目录默认 `~/.dsh/backup-stage`，可在设置页改；备份结束即清空 |
| 恢复撤销副本 | `~/.dsh/restore-undo/<时间戳>/` |
| 离线恢复脚本 | `~/.dsh/backup-restore/<runId>-<时间戳>/` |

目标目录里只有纯压缩包，没有任何插件元数据（历史上的 `.dsh-backup/` 会被顺手清掉，也可以直接删）。

## 宿主接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-backup` | 配置 + 每个计划的错误/上次/下次 + 历史 |
| PUT | `/dsh-backup/config` | 整份写配置 |
| POST | `/dsh-backup/run` | 启动一次备份，立刻返回 `202 {started:true}`，结果看 `/progress` 与 `/history` |
| POST | `/dsh-backup/stop` | 请求停止（在处理完当前文件后中断） |
| GET | `/dsh-backup/progress` | 备份进度 |
| GET | `/dsh-backup/history` | 历史 |
| POST | `/dsh-backup/history/clear` | 清空历史 |
| POST | `/dsh-backup/open` | 系统目录选择窗口 |
| POST | `/dsh-backup/reveal` | 在文件管理器里打开目录 |
| POST | `/dsh-backup/restore` | 在线恢复（`{runId, dest?, mode}`） |
| GET | `/dsh-backup/restore/progress` | 在线恢复进度 |
| POST | `/dsh-backup/restore/export` | 生成离线恢复脚本目录 |
| GET | `/dsh-backup/restore/result` | 最近一次离线恢复的结果 |

## 开发与测试

```bash
npm test     # node test/smoke.mjs
```

测试用真实 HTTP 加载插件跑完整流程（配置 → 备份 → 校验 → 恢复 → 离线脚本执行），会临时建 `DSH_HOME`，不碰真实配置。覆盖点包括：ZIP / TAR.GZ 命名与包内结构、中文文件名、保留份数轮转、空间不足拒绝、暂存结束后自动清空、三种占用策略、离线脚本端到端。

## 已知限制

- DSH 没运行时不会备份，也不补跑；开机后到下一个间隔才开始。
- 同一时刻只允许一个备份任务，第二个直接返回「已有备份任务在执行」。
- 每次都是全量：来源很大时磁盘和耗时都按整份计算，没有增量。
- ZIP 走 PowerShell + .NET：首次调用有 1~2 秒冷启动开销；单包 2GB 上限，大量文件建议用 TAR.GZ。
- 暂存只在单次运行内有效：进程中途被杀（如直接关掉 DSH）会留下 `<暂存目录>/<计划 id>`，下次运行开始时自动清掉再重建。
- 恢复依赖运行记录里保存的来源映射；如果计划被删了又没来源信息，只能恢复到指定目录。
- 离线脚本目前是 Windows 专用（PowerShell + `tar.exe`）；macOS / Linux 的兜底是直接 `tar -xzf` 或解压 zip。
- 暂存期间会占用一份来源大小的磁盘（默认在 `~/.dsh/backup-stage`，可改到目标盘）。

## 后续计划

- 加密（AES-256-GCM）
- 备份前 / 后脚本钩子
- 结果通知（桌面 / 邮件 / Webhook）
- 注册计划任务，实现「下次登录自动跑离线恢复」
- macOS / Linux 的离线恢复脚本
