# dsh-backup · 定时备份

给 DSH 用的备份插件：在 **设置 → 备份** 里配置「一个来源目录 → 一个目标目录」，到点自动备份。

![设置页示意占位]

## 功能

- **定时备份**：每个计划单独设置间隔（5 分钟 / 15 分钟 / 30 分钟 / 每小时 / 每 3 小时 / 每 6 小时 / 每 12 小时 / 每天 / 每周 / 自定义分钟数）。
- **来源单选**：一个计划对应一个来源目录、一个备份；要备份多个目录就建多个计划（`v0.3.0` 起，旧的多来源配置会在加载时按来源自动拆成多个计划，名称加 `-1/-2` 后缀）。
- **目标单选**：一个计划只有一个备份目录；目标不能和来源相同，也不能落在来源目录内部（否则会无限复制）。
- **三种方式**：
  - `复制目录`：可读性最好的全量镜像复制，每次都重新写一遍所有文件，不做删除。
  - `ZIP 包`：`计划名-时间.zip`，走 .NET `ZipFile.CreateFromDirectory`（保留子目录结构，单包约 2GB 上限）。
  - `TAR.GZ 包`：`计划名-时间.tar.gz`，跨平台、无 2GB 限制。
- **保留份数轮转**：压缩包只保留最近 N 份，超出的自动删除（复制模式没有归档包，不参与轮转）。
- **备份后校验**：压缩包重新打开校验条目数；复制模式统计目标文件数与体积。
- **排除规则**：逗号分隔，`*` 通配，按路径片段匹配（`.git` 永远跳过）。
- **时间窗**：只在指定时段运行，适合「只在上班时间备份到 NAS」这类场景。
- **手动立即备份**：不受定时和窗口限制，点了就跑。
- **历史与日志**：每次备份的时间、结果、大小、耗时、逐条日志，压缩包可直接下载。
- **进度**：手动备份时前端轮询进度，能看到已扫描/已复制的文件数。
- **恢复**：历史里每条成功记录都能「恢复」，可覆盖回原始目录或指定目录；被占用的文件按策略跳过/旁路/中止；覆盖前留撤销副本。
- **离线恢复脚本**：一键生成 `run.cmd` + `restore.ps1`，关掉 DSH 后双击运行，脚本会等文件锁释放再覆盖，结果写回 `result.json` 供下次打开时显示。

## 备份包命名与目录结构

压缩包：`<计划名>-<YYYYMMDD-HHmmss>.<zip|tar.gz>`，直接放在目标目录下；例如 `文档-20261106-130803.zip`。计划名里的 `\ / : * ? " < > |` 会替换成 `_`，时间取本机本地时间、连续数字便于排序与阅读。

复制模式不生成包，按 `<目标目录>/<相对路径>` 落盘，也就是来源目录里的文件直接铺在目标根下。

## 恢复

历史表格里状态为「成功」的记录带「恢复」入口，两种方式：

**在线恢复**（DSH 运行中，立刻执行）

- 留空目标 = 覆盖回备份时的原始目录（按 `<来源标签>` 映射回去）；填了目录 = 按包内结构展开到该目录。
- 每个文件独立处理，一个失败不影响其余文件。
- 覆盖前会把旧文件复制到 `~/.dsh/restore-undo/<时间戳>/`，恢复错了可以回滚。
- 目标文件被占用时按策略处理：

| 策略 | 行为 |
| --- | --- |
| `skip`（默认） | 跳过并计入结果，其余文件照常恢复 |
| `sideload` | 写到旁边 `文件名.restore-<时间戳>`，不动原文件 |
| `strict` | 遇到第一个被占用就中止 |

**离线恢复脚本**（DSH 退不出去时必须用这个）

点「生成离线恢复脚本」，会写出：

```
~/.dsh/backup-restore/<runId>-<时间戳>/
├── run.cmd        ← 关闭 DSH 后双击
├── restore.ps1    ← 真正执行的脚本（零依赖，只用 PowerShell + 系统 tar）
├── plan.json      ← 恢复计划（备份包、来源映射、策略、等待时长）
└── result.json    ← 跑完之后才有
```

脚本不会因为文件被占用而失败：它对每个文件轮询独占句柄，默认最多等 600 秒（`plan.json` 里可改 `waitSeconds`），释放后立刻原子替换。跑完把结果写进同目录的 `result.json`，下次打开 DSH 的备份设置页会显示「上次离线恢复」。

被占用又不想等的话，`plan.json` 里可以设 `"relaunch": "dsh.exe 的路径"`，恢复完成后自动拉起 DSH。

## 安装

插件是标准的 DSH bundle（`package.json` 的 `dsh.bundle.patch` + `dsh.client`），装进任何 profile 都行：

### 1. 打包件装（推荐）

```bash
dsh plugin add D:\Az\Agent\dsh-backup\dsh-backup-0.1.0.tgz --profile desktop
```

或者在 Web 的「插件」页 / `plugin_manager` 工具里用这个 `.tgz` 路径做 `installBundle`。
装完 `package.json` 里会留下 `"dsh-backup": "file:.../dsh-backup-0.1.0.tgz"`，并自动加进 `dsh.profile.bundles`。

### 2. 从本地目录装（开发用，改代码即生效）

```bash
dsh plugin add link:D:\Az\Agent\dsh-backup --profile desktop
```

### 3. 手工装（不经过包管理器）

1. 把包里的 `lib/`、`package.json`、`cordis.patch.yml` 放进 `~/.dsh/profiles/<profile>/node_modules/dsh-backup/`
2. 在该 profile 的 `package.json` 里把 `"dsh-backup"` 追加到 `dsh.profile.bundles` 末尾
3. 重启 DSH

**不需要改 profile 的 `cordis.patch.yml`**：这个包自己的 `cordis.patch.yml` 里已经有 `- insert: [{ id: backup, name: 'dsh-backup' }]`，bundle 层会把它合进去。

三处（文件在位、bundles 里有名字、包自带 patch）缺任何一个都会「静默不生效」：设置页不出现，或者出现了但请求全 404。

### 4. 装完为什么要重启

profile 的 bundle 列表只在启动时合成。运行中热装，本机实测会报 `next is not a function`（任何新 bundle 都一样，换最小探针插件也复现），重启 DSH 后正常。所以：**装完重启一次**。

### 5. 检查装好没有

```bash
curl http://127.0.0.1:58237/dsh-backup/health
# {"ok":true,"name":"backup","pid":12345,"uptime":42}
```

设置页出现在「设置 → 备份」，`order` 排在「定时任务」后面。

## 配置与状态文件

- 配置：`~/.dsh/backup.json`
- 运行历史：`~/.dsh/backup-state.json`（保留最近 100 条）

复制模式不再往目标目录写任何元数据，目标目录里只有纯备份内容（历史上的 `.dsh-backup/` 可以放心删除，扫描时会自动跳过）。

每次运行都是全量备份：压缩包每次新建一个，复制模式每次重写全部文件。

## 宿主接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-backup` | 配置 + 每个计划的错误/上次/下次 + 历史 |
| PUT | `/dsh-backup/config` | 整份写配置 |
| POST | `/dsh-backup/run` | 立刻跑一次（同步返回结果） |
| GET | `/dsh-backup/progress` | 正在跑的任务进度 |
| GET | `/dsh-backup/history` | 历史 |
| POST | `/dsh-backup/history/clear` | 清空历史 |
| POST | `/dsh-backup/open` | 系统目录选择窗口（Windows/macOS/Linux） |
| POST | `/dsh-backup/reveal` | 在文件管理器里打开目录 |
| POST | `/dsh-backup/restore` | 在线恢复（`{runId, dest?, mode}`） |
| POST | `/dsh-backup/restore/export` | 生成离线恢复脚本目录 |
| GET | `/dsh-backup/restore/result` | 最近一次离线恢复的结果 |
| GET | `/dsh-backup/restore/progress` | 在线恢复进度 |
| GET | `/dsh-backup/download?run=<id>` | 下载压缩包 |
| GET | `/dsh-backup/health` | 自检 |

## 开发与测试

```bash
npm test        # node test/smoke.mjs：真实 HTTP 加载插件，跑复制/zip 全流程
```

测试会临时建 `DSH_HOME`，不碰真实的 `~/.dsh` 配置。

## 已知限制

- DSH 没运行时不会备份，也不补跑；开机后到下一个间隔才跑。
- 同一时刻只允许一个备份任务（全局互斥），第二个会直接返回“已有任务在执行”。
- 复制模式不做删除同步，来源删掉的文件会留在目标里。
- 复制模式每次全量复制，文件很多时耗时与「增量」不可同日而语。
- ZIP 走 .NET `ZipFile`，单包 2GB 上限、大目录较慢；大量文件建议 tar.gz。
- 加密（AES）暂未实现，建议目标目录本身放在加密卷/受控网盘上。
- 下载接口返回的是本机文件流，只建议在单机环境下用。
- 恢复依赖备份记录里保存的来源映射；如果计划被删掉又没记来源，只能恢复到指定目录。
- 离线脚本是 Windows 专用（PowerShell + `tar.exe`）；macOS/Linux 目前的兜底是直接 `tar -xzf` 或解压 zip。

## 后续可以做

- 备份前/后脚本钩子
- 目标空间预检与断点续传
- 加密与密码派生（AES-256-GCM）
- 注册计划任务，实现「下次登录自动跑离线恢复」
- macOS / Linux 的离线恢复脚本
