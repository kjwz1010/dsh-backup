# 备份（dsh-backup）

把多个目录定时全量打包到一个地方，需要时整个还原。设置页在 **设置 → 备份**。

> 插件页显示名「备份」来自包内 `locale/zh.json` 的 `meta.title`；包名和各项标识仍是 `dsh-backup`。

## 能做什么

- **多来源 → 单目标**：一个计划打包多个来源目录，目标是同一个目录。
- **间隔**：每小时 / 每天 / 每周，或者填任意分钟数。从上次开始时间算，不会堆叠。
- **打包方式**：`TAR.GZ`（不限大小）或 `ZIP`（**单包 2GB 上限**，超了打包前就报错）。
- **排除规则**：逗号分隔，按完整路径里的整段名字匹配，支持 `*` 和 `?`，可写多级路径如 `docs/cache`。写 `electron` 只命中叫这个名字的目录，不会误伤 `my-electron`。
- **保留份数**：只留最近 N 份，旧的自动删。
- **打完校验**：回读压缩包数条目，0 条目算失败。
- **后台跑**：关掉设置页或 DSH 窗口都不中断。
- **恢复**：历史里每条成功记录都能整个还原，支持覆盖回原位或展开到别处。

## 包长什么样

```
<计划名>-<YYYYMMDD-HHmmss>.<zip|tar.gz>
```

计划名里的 `\ / : * ? " < > |` 换成 `_`。包内顶层是各来源目录名，重名时自动加 6 位路径哈希（`docs-1a2b3c`），不会互相覆盖。同一秒连跑两次，后一份加 `-2`。

## 恢复

**在线**（DSH 开着）：文件被占用时按策略处理——`skip` 跳过、`sideload` 写到旁边、`strict` 整体中止。覆盖前留撤销副本到 `~/.dsh/restore-undo/`。

**离线**（文件被 DSH 自己占着，在线一定恢复不动）：点「生成离线恢复脚本」，得到一个目录，关掉 DSH 后双击里面的 `run.cmd`，脚本会等文件锁释放再覆盖。

## 安装

```bash
# 从 gitee 装（推荐）
dsh plugin add https://gitee.com/zhuminming/dsh-backup/repository/archive/master.tar.gz --profile desktop

# 本地改代码时用
dsh plugin add link:D:\AZ\Agent\plugins\dsh-backup --profile desktop
```

或者手工：把包放进 `~/.dsh/profiles/<profile>/node_modules/dsh-backup/`，再把 `dsh-backup` 加进 profile `package.json` 的 `dsh.profile.bundles`。**这一步漏了插件不加载。**

**装完必须重启 DSH**。profile 的 bundle 列表只在启动时合成，运行中热装任何新 bundle 都会报 `operation-error / next is not a function`。

检查装好没有：`curl http://127.0.0.1:<端口>/dsh-backup`，返回 `{"ok":true,...}` 就对了。

## 文件都在哪

| 用途 | 路径 |
| --- | --- |
| 配置 | `~/.dsh/backup.json` |
| 运行历史 | `~/.dsh/backup-state.json`（最近 100 条） |
| 暂存目录 | 默认 `~/.dsh/backup-stage`，备份结束自动清空 |
| 恢复撤销副本 | `~/.dsh/restore-undo/<时间戳>/` |
| 离线恢复脚本 | `~/.dsh/backup-restore/<runId>-<时间戳>/` |

目标目录里只有压缩包，没有插件自己的元数据。

## 常见失败

| 报错 | 原因 | 怎么办 |
| --- | --- | --- |
| `zip 单包上限约 2GB` | ZIP 走 .NET，有 2GB 硬上限 | 换 TAR.GZ |
| `ENOENT, not found in <文件>` | 暂存复制时某个文件读不到 | 多半是正在被程序和占用的运行时目录，把它排除掉 |
| `目标空间不足` | 预留余量不够 | 清目标盘，或调小「预留 MB」 |
| `已有备份任务在执行` | 同一时刻只允许一个 | 等它跑完 |

## 已知限制

- DSH 没运行时不会备份，也不补跑。
- 每次都是全量，没有增量，源大就慢。
- ZIP 首次调用有 1~2 秒冷启动；大目录建议 TAR.GZ。
- 离线恢复脚本目前只支持 Windows（PowerShell + `tar.exe`）。
- 暂存会临时占一份源大小的空间。
