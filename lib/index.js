import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const name = 'backup'
export const inject = ['webServer']

// 路由前缀即设置页里的配置命名空间。
const ROOT = '/dsh-backup'
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CONFIG_FILE = path.join(DSH_HOME, 'backup.json')
const STATE_FILE = path.join(DSH_HOME, 'backup-state.json')
const FORMATS = ['zip', 'tar.gz']

// 正在执行的任务（内存里，供前端轮询进度）。
let ACTIVE = null
// 手动停止标记：备份跑在后台，靠这个标记在文件之间退出。
let STOP_REQUESTED = false

function checkStop() {
  if (STOP_REQUESTED) throw new Error('已手动停止')
}

/* ------------------------------------------------------------------ 通用工具 */

function nowISO() {
  return new Date().toISOString()
}

function makeId() {
  return 'p' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex')
}

function expandHome(value, home = os.homedir()) {
  const text = String(value == null ? '' : value).trim().replace(/^~(?=$|[\\/])/, home)
  return path.normalize(text)
}

function isSubPath(child, parent) {
  const rel = path.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function stamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

function humanBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

function toRegex(rule) {
  const text = String(rule)
  const escaped = text.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp('[\\\\/]' + escaped + '([\\\\/]|$)', 'i')
}

function readJsonSync(file, fallback) {
  try {
    return JSON.parse(fsSync.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

function clamp(value, min, max) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

async function exists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function readBody(req) {
  let raw = ''
  for await (const chunk of req) {
    raw += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    if (raw.length > 2 * 1024 * 1024) throw new Error('请求体过大')
  }
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

function runCommand(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, ...options })
    let out = ''
    let err = ''
    child.stdout?.on('data', (d) => { out += d })
    child.stderr?.on('data', (d) => { err += d })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, out, err }))
  })
}

function powershell(script) {
  return runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script])
}

// 系统里的 tar 可能是 GNU tar，也可能是 Windows 自带的 bsdtar。
// 两者对绝对路径的处理不同：GNU 会把 "C:\..." 当成远程主机（remote:），
// 需要 --force-local 才能当本地路径用；而 bsdtar 不认识这个参数，会直接报
// "Option --force-local is not supported"。所以先探一次版本，再决定加不加。
let TAR_IS_GNU = null
async function tarIsGNU() {
  if (TAR_IS_GNU !== null) return TAR_IS_GNU
  try {
    const probe = await runCommand('tar', ['--version'])
    TAR_IS_GNU = /GNU tar/i.test((probe.out || '') + (probe.err || ''))
  } catch {
    TAR_IS_GNU = false
  }
  return TAR_IS_GNU
}

async function tarArgs(rest) {
  return (await tarIsGNU()) ? ['--force-local', ...rest] : rest
}

function psLiteral(text) {
  return "'" + String(text).replace(/'/g, "''") + "'"
}

/* ------------------------------------------------------------------ 配置 */

function defaultConfig() {
  return {
    version: 1,
    enabled: true,
    tickSeconds: 30,
    stageRoot: path.join(DSH_HOME, 'backup-stage'),
    plans: [],
  }
}

function normalizePlan(input) {
  const plan = input && typeof input === 'object' ? input : {}
  // 兼容 0.3.0 写出的单选配置（plan.source 字符串）：读入时包成单元素数组。
  const sources = Array.isArray(plan.sources) ? plan.sources : plan.source ? [plan.source] : []
  const exclude = Array.isArray(plan.exclude)
    ? plan.exclude
    : String(plan.exclude == null ? '' : plan.exclude).split(/[,，\n]/)
  return {
    id: String(plan.id || makeId()),
    name: String(plan.name || '备份计划').trim() || '备份计划',
    enabled: plan.enabled !== false,
    intervalMinutes: clamp(plan.intervalMinutes, 1, 43200),
    format: FORMATS.includes(plan.format) ? plan.format : 'zip',
    sources: sources.map((s) => expandHome(s)).filter(Boolean).filter((s, i, arr) => arr.indexOf(s) === i),
    target: expandHome(plan.target),
    exclude: exclude.map((s) => String(s).trim()).filter(Boolean),
    keep: clamp(plan.keep, 1, 365),
    verify: plan.verify !== false,
    // 目标磁盘至少保留多少 MB 空闲，0 表示只按估算需求判断。
    reserveMb: clamp(plan.reserveMb, 0, 1048576),
  }
}

function normalizeConfig(raw) {
  const base = defaultConfig()
  if (!raw || typeof raw !== 'object') return base
  return {
    version: 1,
    enabled: raw.enabled !== false,
    tickSeconds: clamp(raw.tickSeconds || base.tickSeconds, 5, 3600),
    // 暂存目录可配置：默认在 ~/.dsh 下，备份大目录时应改到大容量盘。
    stageRoot: safeStageRoot(raw.stageRoot || base.stageRoot),
    plans: Array.isArray(raw.plans) ? raw.plans.map(normalizePlan) : [],
  }
}

function loadConfig() {
  return normalizeConfig(readJsonSync(CONFIG_FILE, null))
}

function loadState() {
  const state = readJsonSync(STATE_FILE, null)
  if (!state || typeof state !== 'object') return { runs: [], lastRunAt: {}, nextRunAt: {} }
  return {
    runs: Array.isArray(state.runs) ? state.runs : [],
    lastRunAt: state.lastRunAt && typeof state.lastRunAt === 'object' ? state.lastRunAt : {},
    nextRunAt: state.nextRunAt && typeof state.nextRunAt === 'object' ? state.nextRunAt : {},
  }
}

async function saveState(state) {
  state.runs = state.runs.slice(0, 100)
  await writeJsonAtomic(STATE_FILE, state)
}

function planErrors(plan) {
  const errors = []
  if (!plan.name) errors.push('计划名称不能为空')
  if (!plan.sources.length) errors.push('至少选择一个来源目录')
  if (new Set(plan.sources.map((s) => path.resolve(s).toLowerCase())).size !== plan.sources.length) {
    errors.push('来源目录有重复，请去掉重复项')
  }
  if (!plan.target) errors.push('请选择备份目标目录')
  if (plan.target) {
    if (plan.sources.some((s) => s === plan.target)) errors.push('目标目录不能与来源目录相同')
    if (plan.sources.some((s) => isSubPath(plan.target, s))) errors.push('目标目录不能位于来源目录内部，否则会无限复制')
  }
  // 暂存目录与来源目录不能互相嵌套：
  //  - 暂存在来源内部 → 备份会把暂存文件一起打进去（自己备份自己）
  //  - 来源在暂存内部 → 备份结束后清空暂存会把来源删掉
  if (plan.sources.length) {
    const stage = stageRootNow()
    if (plan.sources.some((s) => path.resolve(s).toLowerCase() === path.resolve(stage).toLowerCase())) {
      errors.push('暂存目录不能与来源目录相同')
    } else {
      if (plan.sources.some((s) => isSubPath(stage, s))) {
        errors.push('暂存目录不能位于来源目录内部，否则备份会把暂存文件一起打进去')
      }
      if (plan.sources.some((s) => isSubPath(s, stage))) {
        errors.push('来源目录不能位于暂存目录内部，备份结束会清空暂存目录')
      }
    }
  }
  return errors
}

/* ------------------------------------------------------------ 调度 */

function isDue(plan, state, date) {
  if (!plan.enabled) return false
  if (planErrors(plan).length) return false
  const last = Date.parse(state.lastRunAt[plan.id] || '') || 0
  if (!last) return true
  return date.getTime() - last >= plan.intervalMinutes * 60000
}

/* --------------------------------------------------------------- 扫盘与暂存 */

function sourceRootFor(plan, full) {
  let best = null
  for (const source of plan.sources) {
    if (isSubPath(full, source) && (!best || source.length > best.length)) best = source
  }
  return best || plan.sources[0]
}

/* 来源目录在备份中的根名：不同路径但同名的目录（如 D:\a\docs 与 E:\b\docs）
   会互相覆盖，所以重名时统一追加 6 位路径哈希后缀：docs、docs-1a2b3c。 */
function sourceLabels(plan) {
  if (plan._labels) return plan._labels
  const sources = plan.sources || []
  const groups = new Map()
  for (const source of sources) {
    const base = (path.basename(path.normalize(source)) || 'root').replace(/[\\/:*?"<>|]/g, '_')
    if (!groups.has(base)) groups.set(base, [])
    groups.get(base).push(source)
  }
  const labels = new Map()
  for (const [base, list] of groups) {
    if (list.length === 1) {
      labels.set(list[0], base)
      continue
    }
    for (const source of list) {
      const digest = crypto
        .createHash('sha1')
        .update(path.resolve(source).split(path.sep).join('/').toLowerCase())
        .digest('hex')
        .slice(0, 6)
      labels.set(source, `${base}-${digest}`)
    }
  }
  plan._labels = labels
  return labels
}

function relDest(plan, full) {
  const root = sourceRootFor(plan, full)
  const rel = path.relative(root, full)
  const base = sourceLabels(plan).get(root) || path.basename(root) || 'root'
  return path.join(base, rel).split(path.sep).join('/')
}

async function collect(plan, events) {
  const files = []
  const excludes = plan.exclude.map(toRegex)
  const stageRoot = stageRootNow()
  const stack = plan.sources.slice()
  let bytes = 0
  let dirs = 0
  while (stack.length) {
    checkStop()
    const dir = stack.pop()
    dirs += 1
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'EACCES')) continue
      throw err
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (excludes.some((re) => re.test(full))) continue
      // 兜底：绝不去扫暂存目录自身（配置校验已拦截嵌套，这里防历史配置/边界情况）
      if (full === stageRoot || isSubPath(full, stageRoot)) continue
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!entry.isFile()) continue
      let stat
      try {
        stat = await fs.stat(full)
      } catch {
        continue
      }
      files.push({ from: full, to: relDest(plan, full), bytes: stat.size, mtimeMs: stat.mtimeMs })
      bytes += stat.size
      if (files.length % 200 === 0 && events) events.push({ at: nowISO(), text: `已扫描 ${files.length} 个文件` })
    }
  }
  return { files, bytes, dirs }
}

/* ------------------------------------------- 重试 / 空间预检 / 断点续传暂存 */

// Windows 上杀软、索引器、网络盘抖动常会给出这些瞬时错误，重试一般能过。
const TRANSIENT_CODES = new Set(['EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE', 'EPERM', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE'])

async function withRetry(fn, attempts = 3) {
  let last = null
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fn()
    } catch (err) {
      last = err
      if (!TRANSIENT_CODES.has(err && err.code) || i === attempts) break
      await new Promise((resolve) => setTimeout(resolve, 400 * i * i))
    }
  }
  throw last
}

async function freeSpaceOf(dir) {
  try {
    const st = await fs.statfs(dir)
    return Number(st.bavail) * Number(st.bsize)
  } catch {
    return null
  }
}

// 空间预检：宁可开局就拒绝，也别跑到一半把目标磁盘写满。
async function checkSpace(plan, estimated, events) {
  const free = await freeSpaceOf(plan.target)
  if (free == null) {
    events.push({ at: nowISO(), text: '无法读取目标磁盘剩余空间，跳过空间预检' })
    return
  }
  const reserve = (Number(plan.reserveMb) || 0) * 1024 * 1024
  const need = Math.ceil(estimated * 1.05) + 1024 * 1024 + reserve
  if (free < need) {
    throw new Error(`目标空间不足：本次预计需要 ${humanBytes(need)}，目标可用 ${humanBytes(free)}`)
  }
  events.push({ at: nowISO(), text: `空间预检通过：预计需要 ${humanBytes(need)}，可用 ${humanBytes(free)}` })
}

// 暂存目录按计划固定：失败后留在原地，下次按「大小 + mtime」续传，
// 避免几十 GB 的备份每次从头拷一遍。
function stageRootNow() {
  return loadConfig().stageRoot
}

// 暂存目录会被整体清理，必须挡住「盘符根目录」「用户主目录」以及它们的上级目录。
function safeStageRoot(value) {
  const fallback = path.join(DSH_HOME, 'backup-stage')
  const expanded = expandHome(value)
  if (!expanded) return fallback
  const resolved = path.resolve(expanded)
  if (path.parse(resolved).root === resolved) return fallback
  if (resolved === path.resolve(os.homedir())) return fallback
  if (resolved === path.resolve(DSH_HOME)) return fallback
  // 上级目录同样危险：C:\Users 这类会把别人的目录也覆盖进来
  if (isSubPath(DSH_HOME, resolved)) return fallback
  if (isSubPath(os.homedir(), resolved)) return fallback
  return expanded
}

// 只认「暂存目录该有的东西」：<计划 id>/、<计划 id>.json、<计划 id>.json.<pid>.<ts>.tmp
// 计划 id 由 makeId() 生成，形如 p + 时间戳36进制 + 随机hex，因此以 p 开头且不长于 32 位。

function stageDirFor(plan) {
  return path.join(stageRootNow(), plan.id)
}

function stageManifestFor(plan) {
  // 清单放在暂存目录之外，否则会被打进备份包
  return path.join(stageRootNow(), plan.id + '.json')
}

// 统计暂存目录占用（清理按钮与设置页展示用）
async function stageStats() {
  const root = stageRootNow()
  let files = 0
  let bytes = 0
  async function walk(dir) {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      files += 1
      try {
        bytes += (await fs.stat(full)).size
      } catch {
        /* 正在被删的文件忽略 */
      }
    }
  }
  await walk(root)
  return { root, files, bytes }
}

async function stageFiles(plan, stash, events) {
  const stage = stageDirFor(plan)
  // 每次运行都从空目录开始：上一次的残留（例如进程被杀）先清掉，避免新旧文件混在一起。
  await fs.rm(stage, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  await fs.mkdir(stage, { recursive: true })
  let copied = 0
  for (const file of stash.files) {
    checkStop()
    const dest = path.join(stage, file.to.split('/').join(path.sep))
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await withRetry(() => fs.copyFile(file.from, dest))
    copied += 1
    if (copied % 200 === 0) events.push({ at: nowISO(), text: `已暂存 ${copied} 个文件` })
  }
  events.push({ at: nowISO(), text: `暂存完成：${copied} 个文件` })
  return stage
}

async function clearStage(plan) {
  await fs.rm(stageDirFor(plan), { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  await fs.rm(stageManifestFor(plan), { force: true }).catch(() => {})
}

// 0.3 之前的版本会在目标根目录写 .dsh-backup/snapshot.json，新版本已不再生成。
// 每次运行顺手清掉，免得它一直躺在备份目录里。
async function cleanupLegacyMeta(dir) {
  const legacy = path.join(dir, '.dsh-backup')
  try {
    if ((await fs.stat(legacy)).isDirectory()) await fs.rm(legacy, { recursive: true, force: true })
  } catch {
    /* 不存在或删不掉都无所谓 */
  }
}

/* ------------------------------------------------------------------ 归档 */

// 同一秒内连续运行两次时，时间戳会撞车。这里给重名的产物加 -2、-3 后缀，
// 保证每次运行都留下独立的一份，而不是把上一次直接覆盖掉。
async function uniquePath(dir, base, ext) {
  let candidate = path.join(dir, base + ext)
  let n = 2
  while (await exists(candidate)) {
    candidate = path.join(dir, `${base}-${n}${ext}`)
    n += 1
    if (n > 200) break
  }
  return candidate
}

async function makeArchive(plan, stash, sourceDir, events) {
  const base = `${(plan.name || 'backup').replace(/[\\/:*?"<>|]/g, '_')}-${stamp()}`
  await fs.mkdir(sourceDir, { recursive: true })
  if (plan.format === 'zip') {
    const target = await uniquePath(sourceDir, base, '.zip')
    // 用 ZipFile.CreateFromDirectory 而不是 Compress-Archive -LiteralPath：
    // 后者只按文件名入包，会把 <来源标签>/ 目录结构拍平，多个来源的同名文件会互相覆盖。
    const script = [
      "$ErrorActionPreference='Stop'",
      'Add-Type -AssemblyName System.IO.Compression.FileSystem',
      `if (Test-Path -LiteralPath ${psLiteral(target)}) { Remove-Item -LiteralPath ${psLiteral(target)} -Force }`,
      `[System.IO.Compression.ZipFile]::CreateFromDirectory(${psLiteral(stash.dir)}, ${psLiteral(target)}, [System.IO.Compression.CompressionLevel]::Optimal, $false)`,
    ].join('; ')
    const result = await powershell(script)
    if (result.code !== 0) throw new Error('zip 失败：' + (result.err || result.out || '未知错误').trim().slice(0, 400))
    if (!(await exists(target))) throw new Error('zip 归档未生成')
    events.push({ at: nowISO(), text: `已生成压缩包 ${path.basename(target)}` })
    const size = (await fs.stat(target)).size
    return { path: target, kind: 'zip', size }
  }
  const target = await uniquePath(sourceDir, base, '.tar.gz')
  // 不能用 -T <清单文件>：Windows 上的 bsdtar 按系统 ANSI 码页解析清单，
  // UTF-8 的中文文件名会被解成空串，报 "tar: : Couldn't visit directory"。
  // 也不能打包 "."：那样包里会多出一条 "." 根条目，解压工具会把它显示成多余的“本地磁盘”层。
  // 只把顶层目录（各来源的标签目录）作为参数交给 tar，文件名仍由目录枚举（宽字符 API）读出。
  const entries = [...new Set(stash.files.map((f) => String(f.to).split('/')[0]))].filter(Boolean).sort()
  if (!entries.length) throw new Error('tar.gz 失败：没有可打包的内容')
  const result = await runCommand('tar', await tarArgs(['-czf', target, '-C', stash.dir, ...entries]))
  if (result.code !== 0) throw new Error('tar.gz 失败：' + (result.err || result.out || '未知错误').trim().slice(0, 400))
  if (!(await exists(target))) throw new Error('tar.gz 归档未生成')
  events.push({ at: nowISO(), text: `已生成压缩包 ${path.basename(target)}` })
  const size = (await fs.stat(target)).size
  return { path: target, kind: 'tar.gz', size }
}

async function verify(plan, run, target) {
  if (!plan.verify) return null
  if (run.archive && run.archive.kind === 'tar.gz') {
    const result = await runCommand('tar', await tarArgs(['-tzf', run.archive.path]))
    if (result.code !== 0) throw new Error('校验失败：' + (result.err || result.out || '').trim().slice(0, 400))
    const count = result.out.split(/\r?\n/).filter(Boolean).length
    if (!count) throw new Error('校验失败：压缩包内没有条目')
    return { ok: true, detail: `解压清单校验通过（${count} 个条目）` }
  }
  if (run.archive && run.archive.kind === 'zip') {
    const script = [
      'Add-Type -AssemblyName System.IO.Compression.FileSystem',
      `$z = [System.IO.Compression.ZipFile]::OpenRead(${psLiteral(run.archive.path)})`,
      'try { $n = $z.Entries.Count } finally { $z.Dispose() }',
      "if ($n -lt 1) { throw '压缩包为空' }",
      'Write-Output $n',
    ].join('; ')
    const result = await powershell(script)
    if (result.code !== 0) throw new Error('校验失败：' + (result.err || result.out || '').trim().slice(0, 400))
    return { ok: true, detail: `zip 完整性校验通过（${result.out.trim()} 个条目）` }
  }
}

async function rotate(plan) {
  if (plan.keep >= 365) return []
  let entries
  try {
    entries = await fs.readdir(plan.target)
  } catch {
    return []
  }
  const prefix = (plan.name || 'backup').replace(/[\\/:*?"<>|]/g, '_') + '-'
  const ext = plan.format === 'zip' ? '.zip' : '.tar.gz'
  const kept = entries
    .filter((name) => name.startsWith(prefix) && name.endsWith(ext))
    .map((name) => ({ name, full: path.join(plan.target, name) }))
    .sort((a, b) => (a.name < b.name ? 1 : -1))
  const removed = []
  for (const item of kept.slice(plan.keep)) {
    try {
      await fs.rm(item.full, { force: true, recursive: false })
      removed.push(item.name)
    } catch {
      /* ignore */
    }
  }
  return removed
}

/* ------------------------------------------------------------------ 执行一次 */

function elapsed(startedAt) {
  const ms = Date.now() - (Date.parse(startedAt) || Date.now())
  if (ms < 1000) return ms + 'ms'
  return (ms / 1000).toFixed(1) + 's'
}

async function runPlan(plan, trigger, options = {}) {
  const state = loadState()
  if (state.runs.some((run) => run.status === 'running')) {
    return { ok: false, error: '已有备份任务在执行，请稍后再试' }
  }
  const errors = planErrors(plan)
  if (errors.length) return { ok: false, error: errors.join('；') }

  const run = {
    id: makeId(),
    planId: plan.id,
    planName: plan.name,
    trigger: trigger || 'manual',
    status: 'running',
    startedAt: nowISO(),
    finishedAt: null,
    durationMs: null,
    files: 0,
    bytes: 0,
    copied: 0,
    archive: null,
    verify: null,
    rotated: [],
    error: null,
    // 记下运行时的来源/目标/来源标签，恢复时才能把包内路径映射回原始目录。
    target: plan.target,
    sources: plan.sources.slice(),
    labels: [...sourceLabels(plan)].map(([source, label]) => ({ label, source })),
    log: [],
  }
  const events = run.log
  const push = (entry) => {
    if (events.length < 200) events.push(entry)
  }
  ACTIVE = run
  STOP_REQUESTED = false
  state.runs.unshift(run)
  await saveState(state)

  let stashDir = null
  try {
    push({ at: nowISO(), text: `开始备份「${plan.name}」` })
    if (!(await exists(plan.target))) await fs.mkdir(plan.target, { recursive: true })
    const stash = await collect(plan, events)
    checkStop()
    run.files = stash.files.length
    run.bytes = stash.bytes
    if (!stash.files.length) throw new Error('来源目录里没有可备份的文件')
    push({ at: nowISO(), text: `扫描完成：${stash.files.length} 个文件，共 ${humanBytes(stash.bytes)}` })

    await cleanupLegacyMeta(plan.target)
    await checkSpace(plan, stash.bytes, events)
    if (plan.format === 'zip' && stash.bytes > 1.8 * 1024 * 1024 * 1024) {
      throw new Error('zip 单包上限约 2GB，请改用 tar.gz 或拆分来源')
    }
    checkStop()
    stashDir = await stageFiles(plan, stash, events)
    run.copied = stash.files.length
    checkStop()
    run.archive = await makeArchive(plan, { files: stash.files, dir: stashDir }, plan.target, events)

    run.verify = await verify(plan, run, plan.target)
    if (run.verify) push({ at: nowISO(), text: run.verify.detail })

    run.rotated = await rotate(plan)
    if (run.rotated.length) push({ at: nowISO(), text: `轮转清理旧备份 ${run.rotated.length} 个` })

    run.status = 'success'
  } catch (err) {
    run.status = 'failed'
    run.error = String((err && err.message) || err).slice(0, 800)
    push({ at: nowISO(), text: '失败：' + run.error })
  } finally {
    run.finishedAt = nowISO()
    run.durationMs = Date.now() - (Date.parse(run.startedAt) || Date.now())
    // 无论成功失败都清空暂存，备份结束后不留任何临时文件。
    await clearStage(plan)
    if (run.status !== 'running') {
      const fresh = loadState()
      const index = fresh.runs.findIndex((item) => item.id === run.id)
      if (index >= 0) fresh.runs[index] = run
      else fresh.runs.unshift(run)
      fresh.lastRunAt[plan.id] = run.startedAt
      const next = Date.parse(run.startedAt) + plan.intervalMinutes * 60000
      fresh.nextRunAt[plan.id] = new Date(next).toISOString()
      await saveState(fresh)
    }
    push({ at: nowISO(), text: `结束：${run.status}，用时 ${elapsed(run.startedAt)}` })
    ACTIVE = null
  }
  return { ok: run.status === 'success', run }
}

/* ------------------------------------------------------------------ 路由 */

/* ------------------------------------------------------------------ 恢复 */

let RUN_STARTING = false

const RESTORE_DIR = path.join(DSH_HOME, 'backup-restore')
let ACTIVE_RESTORE = null

function restoreRunById(runId) {
  const state = loadState()
  const run = state.runs.find((item) => item.id === runId)
  if (!run) throw new Error('找不到这条备份记录')
  if (run.status !== 'success') throw new Error('只有成功的备份记录才能恢复')
  return run
}

function restoreMapping(run) {
  if (run.labels && run.labels.length) return run.labels
  const cfg = loadConfig()
  const plan = cfg.plans.find((item) => item.id === run.planId)
  if (!plan) return []
  return [...sourceLabels(plan)].map(([source, label]) => ({ label, source }))
}

function restoreMode(mode) {
  return mode === 'sideload' || mode === 'strict' ? mode : 'skip'
}

async function walkFiles(root) {
  const out = []
  const stack = [root]
  while (stack.length) {
    checkStop()
    const dir = stack.pop()
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) out.push(full)
    }
  }
  return out
}

// 用 rename 探测占用：被独占打开的文件改不了名，且探测失败不会损坏原文件。
async function isLocked(dest) {
  const probe = dest + '.dsh-lock-probe'
  try {
    await fs.rename(dest, probe)
  } catch {
    return true
  }
  try {
    await fs.rename(probe, dest)
  } catch {
    /* 探针被别的进程抢走的极端情况，按未占用处理 */
  }
  return false
}

async function placeFile(from, dest, rel, mode, undoRoot, stats) {
  await fs.mkdir(path.dirname(dest), { recursive: true })
  const present = await exists(dest)
  if (present && (await isLocked(dest))) {
    if (mode === 'strict') throw new Error('文件被占用：' + dest)
    if (mode === 'skip') {
      stats.skipped.push(dest)
      return
    }
    const aside = dest + '.restore-' + stamp().replace(/:/g, '')
    await fs.copyFile(from, aside)
    stats.sideloaded.push(aside)
    return
  }
  if (present) {
    const undo = path.join(undoRoot, rel.split('/').join(path.sep))
    await fs.mkdir(path.dirname(undo), { recursive: true })
    await fs.copyFile(dest, undo)
  }
  const tmp = dest + '.dsh-restoring'
  await fs.copyFile(from, tmp)
  try {
    await fs.rename(tmp, dest)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    if (mode === 'strict') throw err
    if (mode === 'skip') {
      stats.skipped.push(dest)
      return
    }
    const aside = dest + '.restore-' + stamp().replace(/:/g, '')
    await fs.copyFile(from, aside)
    stats.sideloaded.push(aside)
    return
  }
  stats.restored += 1
}

async function runRestore(body) {
  const run = restoreRunById(body.runId)
  const mode = restoreMode(body.mode)
  const dest = body.dest ? expandHome(body.dest) : ''
  if (!run.archive) throw new Error('这条备份没有可恢复的压缩包')
  const mapping = restoreMapping(run)
  if (!mapping.length && !dest) {
    throw new Error('这条备份没有来源映射，无法自动定位恢复位置，请指定「恢复到目录」')
  }
  const byLabel = new Map(mapping.map((item) => [item.label, item.source]))
  const undoRoot = path.join(DSH_HOME, 'restore-undo', stamp().replace(/:/g, ''))
  const stats = { restored: 0, skipped: [], sideloaded: [], total: 0 }
  ACTIVE_RESTORE = { startedAt: nowISO(), done: 0, total: 0, mode }
  let stage = null
  try {
    if (run.archive) {
      stage = path.join(os.tmpdir(), 'dsh-restore-' + Date.now().toString(36))
      await fs.mkdir(stage, { recursive: true })
      if (run.archive.kind === 'zip') {
        const result = await powershell(
          "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath " +
            psLiteral(run.archive.path) +
            ' -DestinationPath ' +
            psLiteral(stage) +
            ' -Force',
        )
        if (result.code !== 0) throw new Error('解压失败：' + (result.err || result.out || '未知错误').trim().slice(0, 400))
      } else {
        const result = await runCommand('tar', await tarArgs(['-xzf', run.archive.path, '-C', stage]))
        if (result.code !== 0) throw new Error('解压失败：' + (result.err || result.out || '未知错误').trim().slice(0, 400))
      }
      const files = await walkFiles(stage)
      stats.total = files.length
      ACTIVE_RESTORE.total = files.length
      for (const file of files) {
        const rel = path.relative(stage, file).split(path.sep).join('/')
        const cut = rel.indexOf('/')
        const label = cut < 0 ? '' : rel.slice(0, cut)
        const inner = cut < 0 ? rel : rel.slice(cut + 1)
        let target = ''
        if (dest) {
          target = path.join(dest, rel.split('/').join(path.sep))
        } else {
          const root = byLabel.get(label)
          if (!root) {
            stats.skipped.push(file)
            ACTIVE_RESTORE.done += 1
            continue
          }
          target = path.join(root, inner.split('/').join(path.sep))
        }
        await placeFile(file, target, rel, mode, undoRoot, stats)
        ACTIVE_RESTORE.done += 1
      }
    }
    return {
      ok: true,
      restored: stats.restored,
      skipped: stats.skipped,
      sideloaded: stats.sideloaded,
      total: stats.total,
      undoDir: stats.restored ? undoRoot : null,
      mode,
    }
  } finally {
    ACTIVE_RESTORE = null
    if (stage) await fs.rm(stage, { recursive: true, force: true }).catch(() => {})
  }
}

// 生成「离线恢复」脚本：DSH 只负责写文件，真正动手的是退出 DSH 后双击的 run.cmd。
async function exportRestore(body) {
  const run = restoreRunById(body.runId)
  const cfg = loadConfig()
  const plan = cfg.plans.find((item) => item.id === run.planId)
  const data = {
    version: 1,
    createdAt: nowISO(),
    runId: run.id,
    planName: run.planName || '',
    mode: restoreMode(body.mode),
    waitSeconds: clamp(Number(body.waitSeconds) || 600, 10, 86400),
    dest: body.dest ? expandHome(body.dest) : '',
    archive: run.archive ? { path: run.archive.path, kind: run.archive.kind } : null,
    mapping: restoreMapping(run),
    relaunch: body.relaunch ? expandHome(body.relaunch) : '',
  }
  if (!data.archive) throw new Error('这条备份没有可用的备份包')
  const dir = path.join(RESTORE_DIR, run.id + '-' + stamp().replace(/:/g, ''))
  await fs.mkdir(dir, { recursive: true })
  await writeJsonAtomic(path.join(dir, 'plan.json'), data)
  const script = await fs.readFile(fileURLToPath(new URL('./restore.ps1', import.meta.url)), 'utf8')
  await fs.writeFile(path.join(dir, 'restore.ps1'), '\ufeff' + script, 'utf8')
  const cmd = [
    '@echo off',
    'chcp 65001 >nul',
    'setlocal',
    'rem Close DSH first, then double-click this file.',
    'rem The script waits until locked files are released, then restores.',
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0restore.ps1"',
    'echo.',
    'pause',
    '',
  ].join('\r\n')
  await fs.writeFile(path.join(dir, 'run.cmd'), cmd, 'ascii')
  return { ok: true, dir, plan: data }
}

async function latestRestoreResult() {
  let entries = []
  try {
    entries = await fs.readdir(RESTORE_DIR)
  } catch {
    return null
  }
  const dirs = []
  for (const name of entries) {
    const full = path.join(RESTORE_DIR, name)
    const file = path.join(full, 'result.json')
    try {
      const stat = await fs.stat(file)
      dirs.push({ dir: full, file, mtime: stat.mtimeMs })
    } catch {
      /* 还没有结果 */
    }
  }
  dirs.sort((a, b) => b.mtime - a.mtime)
  if (!dirs.length) return null
  try {
    const data = JSON.parse(await fs.readFile(dirs[0].file, 'utf8'))
    return { dir: dirs[0].dir, result: data }
  } catch {
    return null
  }
}

async function pickFolder(kind) {
  if (process.platform === 'win32') {
    const title = kind === 'target' ? '选择备份目标目录' : '选择需要备份的目录'
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      `$dialog.Description = ${psLiteral(title)}`,
      '$dialog.ShowNewFolderButton = $true',
      'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }',
    ].join('; ')
    const result = await powershell(script)
    const picked = (result.out || '').trim()
    if (result.code !== 0) return { ok: false, error: '无法打开系统目录选择窗口' }
    if (!picked) return { ok: true, cancelled: true }
    return { ok: true, path: picked }
  }
  if (process.platform === 'darwin') {
    const script = `POSIX path of (choose folder with prompt ${JSON.stringify(kind === 'target' ? '选择备份目标目录' : '选择需要备份的目录')})`
    const result = await runCommand('osascript', ['-e', script])
    const picked = (result.out || '').trim()
    if (result.code !== 0) return { ok: true, cancelled: true }
    return { ok: true, path: picked.replace(/\/$/, '') }
  }
  const result = await runCommand('zenity', ['--file-selection', '--directory', '--title', kind === 'target' ? '选择备份目标目录' : '选择需要备份的目录'])
  const picked = (result.out || '').trim()
  if (result.code !== 0) return { ok: true, cancelled: true }
  return { ok: true, path: picked }
}


export function apply(ctx, config = {}) {
  let timer = null
  let ticking = false

  async function tick() {
    if (ticking) return
    ticking = true
    try {
      const cfg = loadConfig()
      if (!cfg.enabled) return
      const state = loadState()
      const date = new Date()
      for (const plan of cfg.plans) {
        if (!isDue(plan, state, date)) continue
        const result = await runPlan(plan, 'scheduled')
        if (!result.ok && result.error) {
          console.warn('[dsh-backup] 计划「' + plan.name + '」跳过：' + result.error)
        }
        break
      }
    } catch (err) {
      console.error('[dsh-backup] 调度异常', err)
    } finally {
      ticking = false
    }
  }

  async function restartTimer() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    const cfg = loadConfig()
    const seconds = clamp(cfg.tickSeconds || 30, 5, 3600)
    timer = setInterval(() => { tick() }, seconds * 1000)
    timer.unref?.()
  }

  const routes = [
    [ROOT, async (req, res) => {
      const cfg = loadConfig()
      const state = loadState()
      const plans = cfg.plans.map((plan) => ({
        ...plan,
        errors: planErrors(plan),
        lastRunAt: state.lastRunAt[plan.id] || null,
        nextRunAt: state.nextRunAt[plan.id] || null,
        dueIn: state.lastRunAt[plan.id]
          ? Math.max(0, Date.parse(state.lastRunAt[plan.id]) + plan.intervalMinutes * 60000 - Date.now())
          : 0,
      }))
      sendJSON(res, 200, {
        ok: true,
        config: { ...cfg, plans },
        state: { runs: state.runs.slice(0, 100), lastRunAt: state.lastRunAt, nextRunAt: state.nextRunAt },
        environment: { platform: process.platform, dshHome: DSH_HOME },
        stage: await stageStats(),
        formats: FORMATS,
      })
    }],
    [ROOT + '/config', async (req, res) => {
      if (req.method !== 'PUT' && req.method !== 'POST') {
        sendJSON(res, 405, { ok: false, error: '只支持 PUT' })
        return
      }
      const body = await readBody(req)
      const cfg = normalizeConfig(body && body.config ? body.config : body)
      const warnings = []
      for (const plan of cfg.plans) {
        const errors = planErrors(plan)
        if (errors.length) warnings.push({ plan: plan.name, errors })
      }
      await writeJsonAtomic(CONFIG_FILE, cfg)
      await restartTimer()
      sendJSON(res, 200, { ok: true, config: cfg, warnings })
    }],
    [ROOT + '/run', async (req, res) => {
      if (req.method !== 'POST') {
        sendJSON(res, 405, { ok: false, error: '只支持 POST' })
        return
      }
      const body = await readBody(req)
      const cfg = loadConfig()
      const plan = cfg.plans.find((item) => item.id === body.planId)
      if (!plan) {
        sendJSON(res, 404, { ok: false, error: '找不到这个备份计划' })
        return
      }
      // 备份放到后台跑，不等这个 HTTP 请求：关掉设置页、断网都不会影响正在进行的备份。
      if (ACTIVE || RUN_STARTING) {
        sendJSON(res, 409, { ok: false, error: '已有备份任务在执行，请稍后再试' })
        return
      }
      // 计划本身有问题就直接拒绝，别让后台跑出一个“开始了但立刻失败”的假象
      const errors = planErrors(plan)
      if (errors.length) {
        sendJSON(res, 400, { ok: false, error: errors.join('；') })
        return
      }
      RUN_STARTING = true
      runPlan(plan, body.trigger === 'scheduled' ? 'scheduled' : 'manual')
        .catch(() => {})
        .finally(() => {
          RUN_STARTING = false
        })
      sendJSON(res, 202, { ok: true, started: true, planId: plan.id })
    }],
    [ROOT + '/stop', async (req, res) => {
      if (!ACTIVE) {
        sendJSON(res, 200, { ok: true, running: false, note: '当前没有正在运行的备份' })
        return
      }
      STOP_REQUESTED = true
      sendJSON(res, 200, { ok: true, running: true, note: '已请求停止，当前文件处理完就中断' })
    }],
    [ROOT + '/progress', async (req, res) => {
      if (!ACTIVE) {
        sendJSON(res, 200, { ok: true, running: null })
        return
      }
      sendJSON(res, 200, {
        ok: true,
        running: {
          id: ACTIVE.id,
          planId: ACTIVE.planId,
          planName: ACTIVE.planName,
          status: ACTIVE.status,
          startedAt: ACTIVE.startedAt,
          files: ACTIVE.files,
          bytes: ACTIVE.bytes,
          copied: ACTIVE.copied,
          log: ACTIVE.log.slice(-6),
        },
      })
    }],
    [ROOT + '/open', async (req, res) => {
      if (req.method !== 'POST') {
        sendJSON(res, 405, { ok: false, error: '只支持 POST' })
        return
      }
      const body = await readBody(req)
      const result = await pickFolder(body.kind === 'target' ? 'target' : 'source')
      sendJSON(res, 200, result)
    }],
    [ROOT + '/reveal', async (req, res) => {
      if (req.method !== 'POST') {
        sendJSON(res, 405, { ok: false, error: '只支持 POST' })
        return
      }
      const body = await readBody(req)
      const target = expandHome(body.path)
      if (!target || !(await exists(target))) {
        sendJSON(res, 404, { ok: false, error: '目录不存在' })
        return
      }
      const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
      // windowsHide 会让 explorer 以 CREATE_NO_WINDOW 启动，窗口不出现，所以这里不能带。
      spawn(cmd, [target], { detached: true, stdio: 'ignore' }).unref()
      sendJSON(res, 200, { ok: true })
    }],
    [ROOT + '/history', async (req, res) => {
      const state = loadState()
      sendJSON(res, 200, { ok: true, runs: state.runs.slice(0, 100) })
    }],
    [ROOT + '/history/clear', async (req, res) => {
      if (req.method !== 'POST') {
        sendJSON(res, 405, { ok: false, error: '只支持 POST' })
        return
      }
      const state = loadState()
      state.runs = state.runs.filter((run) => run.status === 'running')
      await saveState(state)
      sendJSON(res, 200, { ok: true })
    }],
    [ROOT + '/restore', async (req, res) => {
      if (req.method !== 'POST') {
        sendJSON(res, 405, { ok: false, error: '只支持 POST' })
        return
      }
      const body = await readBody(req)
      const result = await runRestore(body)
      sendJSON(res, 200, result)
    }],
    [ROOT + '/restore/progress', async (req, res) => {
      if (!ACTIVE_RESTORE) {
        sendJSON(res, 200, { ok: true, running: null })
        return
      }
      sendJSON(res, 200, { ok: true, running: ACTIVE_RESTORE })
    }],
    [ROOT + '/restore/export', async (req, res) => {
      if (req.method !== 'POST') {
        sendJSON(res, 405, { ok: false, error: '只支持 POST' })
        return
      }
      const body = await readBody(req)
      const result = await exportRestore(body)
      sendJSON(res, 200, result)
    }],
    [ROOT + '/restore/result', async (req, res) => {
      const latest = await latestRestoreResult()
      sendJSON(res, 200, latest ? { ok: true, dir: latest.dir, result: latest.result } : { ok: true, result: null })
    }],
  ]

  ctx.effect(() => {
    const disposers = []
    for (const [route, handler] of routes) {
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: route,
        handler: async (req, res) => {
          try {
            await handler(req, res)
          } catch (err) {
            try {
              sendJSON(res, 500, { ok: false, error: String((err && err.message) || err) })
            } catch {
              /* response already sent */
            }
          }
        },
      }))
    }
    restartTimer().catch((err) => console.error('[dsh-backup] 调度初始化失败', err))
    return () => {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
    }
  }, 'dsh-backup')
}
