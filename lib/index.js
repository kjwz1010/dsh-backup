import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

export const name = 'backup'
export const inject = ['webServer']

// 路由前缀即设置页里的配置命名空间。
const ROOT = '/dsh-backup'
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CONFIG_FILE = path.join(DSH_HOME, 'backup.json')
const STATE_FILE = path.join(DSH_HOME, 'backup-state.json')
const FORMATS = ['copy', 'zip', 'tar.gz']

// 正在执行的任务（内存里，供前端轮询进度）。
let ACTIVE = null

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
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
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

function psLiteral(text) {
  return "'" + String(text).replace(/'/g, "''") + "'"
}

/* ------------------------------------------------------------------ 配置 */

function defaultConfig() {
  return {
    version: 1,
    enabled: true,
    tickSeconds: 30,
    plans: [],
  }
}

function normalizePlan(input) {
  const plan = input && typeof input === 'object' ? input : {}
  const sources = Array.isArray(plan.sources) ? plan.sources : []
  const exclude = Array.isArray(plan.exclude)
    ? plan.exclude
    : String(plan.exclude == null ? '' : plan.exclude).split(/[,，\n]/)
  return {
    id: String(plan.id || makeId()),
    name: String(plan.name || '备份计划').trim() || '备份计划',
    enabled: plan.enabled !== false,
    intervalMinutes: clamp(plan.intervalMinutes, 1, 43200),
    format: FORMATS.includes(plan.format) ? plan.format : 'copy',
    sources: sources.map((s) => expandHome(s)).filter(Boolean).filter((s, i, arr) => arr.indexOf(s) === i),
    target: expandHome(plan.target),
    exclude: exclude.map((s) => String(s).trim()).filter(Boolean),
    keep: clamp(plan.keep, 1, 365),
    verify: plan.verify !== false,
    window: {
      enabled: Boolean(plan.window && plan.window.enabled),
      start: /^\d{2}:\d{2}$/.test(String(plan.window && plan.window.start)) ? plan.window.start : '00:00',
      end: /^\d{2}:\d{2}$/.test(String(plan.window && plan.window.end)) ? plan.window.end : '23:59',
    },
  }
}

function normalizeConfig(raw) {
  const base = defaultConfig()
  if (!raw || typeof raw !== 'object') return base
  return {
    version: 1,
    enabled: raw.enabled !== false,
    tickSeconds: clamp(raw.tickSeconds || base.tickSeconds, 5, 3600),
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
  if (!plan.target) errors.push('请选择备份目标目录')
  if (plan.target) {
    if (plan.sources.some((s) => s === plan.target)) errors.push('目标目录不能与来源目录相同')
    if (plan.sources.some((s) => isSubPath(plan.target, s))) errors.push('目标目录不能位于来源目录内部，否则会无限复制')
  }
  return errors
}

/* ------------------------------------------------------------ 时间窗口 & 调度 */

function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes()
}

function inWindow(plan, date) {
  if (!plan.window.enabled) return true
  const [sh, sm] = plan.window.start.split(':').map(Number)
  const [eh, em] = plan.window.end.split(':').map(Number)
  const start = sh * 60 + sm
  const end = eh * 60 + em
  const cur = minutesOfDay(date)
  return start <= end ? cur >= start && cur <= end : cur >= start || cur <= end
}

function isDue(plan, state, date) {
  if (!plan.enabled) return false
  if (planErrors(plan).length) return false
  const last = Date.parse(state.lastRunAt[plan.id] || '') || 0
  if (!last) return inWindow(plan, date)
  if (date.getTime() - last < plan.intervalMinutes * 60000) return false
  if (!inWindow(plan, date)) return false
  return true
}

/* --------------------------------------------------------------- 扫盘 & 复制 */

function sourceRootFor(plan, full) {
  let best = null
  for (const source of plan.sources) {
    if (isSubPath(full, source) && (!best || source.length > best.length)) best = source
  }
  return best || plan.sources[0]
}

function relDest(plan, full) {
  const root = sourceRootFor(plan, full)
  const rel = path.relative(root, full)
  const base = path.basename(root) || 'root'
  return path.join(base, rel).split(path.sep).join('/')
}

async function collect(plan, events) {
  const files = []
  const excludes = plan.exclude.map(toRegex)
  const stack = plan.sources.slice()
  let bytes = 0
  let dirs = 0
  while (stack.length) {
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
      if (entry.isDirectory()) {
        if (entry.name === '.git') continue
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

async function writeSnapshotMeta(target, meta) {
  const dir = path.join(target, '.dsh-backup')
  await fs.mkdir(dir, { recursive: true })
  await writeJsonAtomic(path.join(dir, 'snapshot.json'), meta)
}

function readSnapshotMeta(target) {
  try {
    const data = JSON.parse(fsSync.readFileSync(path.join(target, '.dsh-backup', 'snapshot.json'), 'utf8'))
    const map = new Map()
    for (const item of data.files || []) map.set(item.to, item)
    return { savedAt: data.savedAt || '', files: map }
  } catch {
    return { savedAt: '', files: new Map() }
  }
}

async function copyInto(plan, target, stash, events) {
  const previous = readSnapshotMeta(target)
  let copied = 0
  let unchanged = 0
  const saved = []
  for (const file of stash.files) {
    const dest = path.join(target, file.to.split('/').join(path.sep))
    const before = previous.files.get(file.to)
    let stat = null
    try {
      stat = await fs.stat(dest)
    } catch {
      stat = null
    }
    if (before && stat && stat.size === file.bytes) {
      unchanged += 1
      saved.push({ to: file.to, size: file.bytes })
      continue
    }
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.copyFile(file.from, dest)
    copied += 1
    saved.push({ to: file.to, size: file.bytes })
    if (copied % 100 === 0 && events) events.push({ at: nowISO(), text: `已复制 ${copied} 个文件` })
  }
  await writeSnapshotMeta(target, { savedAt: nowISO(), files: saved })
  return { copied, unchanged }
}

/* ------------------------------------------------------------------ 归档 */

async function makeArchive(plan, stash, sourceDir, events) {
  const base = `${(plan.name || 'backup').replace(/[\\/:*?"<>|]/g, '_')}-${stamp()}`
  await fs.mkdir(sourceDir, { recursive: true })
  const listFile = path.join(stash.dir, 'files.txt')
  if (plan.format === 'zip') {
    const target = path.join(sourceDir, base + '.zip')
    await fs.writeFile(listFile, stash.files.map((f) => f.to).join('\r\n'), 'utf8')
    const script = [
      "$ErrorActionPreference='Stop'",
      `$list = Get-Content -LiteralPath ${psLiteral(listFile)} -Encoding UTF8`,
      `$root = ${psLiteral(stash.dir)}`,
      '$items = @(foreach ($f in $list) { if ($f) { Join-Path $root $f } })',
      `if ($items.Count -gt 0) { Compress-Archive -LiteralPath $items -DestinationPath ${psLiteral(target)} -CompressionLevel Optimal -Force }`,
    ].join('; ')
    const result = await powershell(script)
    if (result.code !== 0) throw new Error('zip 失败：' + (result.err || result.out || '未知错误').trim().slice(0, 400))
    if (!(await exists(target))) throw new Error('zip 归档未生成')
    events.push({ at: nowISO(), text: `已生成压缩包 ${path.basename(target)}` })
    const size = (await fs.stat(target)).size
    return { path: target, kind: 'zip', size }
  }
  const target = path.join(sourceDir, base + '.tar.gz')
  await fs.writeFile(listFile, stash.files.map((f) => f.to).join('\n'), 'utf8')
  const result = await runCommand('tar', ['--force-local', '-czf', target, '-C', stash.dir, '-T', listFile])
  if (result.code !== 0) throw new Error('tar.gz 失败：' + (result.err || result.out || '未知错误').trim().slice(0, 400))
  if (!(await exists(target))) throw new Error('tar.gz 归档未生成')
  events.push({ at: nowISO(), text: `已生成压缩包 ${path.basename(target)}` })
  const size = (await fs.stat(target)).size
  return { path: target, kind: 'tar.gz', size }
}

async function verify(plan, run, target) {
  if (!plan.verify) return null
  if (run.archive && run.archive.kind === 'tar.gz') {
    const result = await runCommand('tar', ['--force-local', '-tzf', run.archive.path])
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
  const check = await verifyDirectory(target)
  return check
}

async function verifyDirectory(dir) {
  let files = 0
  let bytes = 0
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try {
      entries = await fs.readdir(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name === '.dsh-backup') continue
      const full = path.join(cur, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) {
        files += 1
        try {
          bytes += (await fs.stat(full)).size
        } catch {
          /* ignore */
        }
      }
    }
  }
  if (!files) throw new Error('校验失败：目标目录里没有备份内容')
  return { ok: true, detail: `目录校验通过（${files} 个文件 / ${humanBytes(bytes)}）` }
}

async function rotate(plan) {
  if (plan.format === 'copy' || plan.keep >= 365) return []
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
      await fs.rm(item.full, { force: true })
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
    unchanged: 0,
    archive: null,
    verify: null,
    rotated: [],
    error: null,
    log: [],
  }
  const events = run.log
  const push = (entry) => {
    if (events.length < 200) events.push(entry)
  }
  ACTIVE = run
  state.runs.unshift(run)
  await saveState(state)

  let stashDir = null
  try {
    push({ at: nowISO(), text: `开始备份「${plan.name}」` })
    if (!(await exists(plan.target))) await fs.mkdir(plan.target, { recursive: true })
    const stash = await collect(plan, events)
    run.files = stash.files.length
    run.bytes = stash.bytes
    if (!stash.files.length && plan.format !== 'copy') throw new Error('来源目录里没有可备份的文件')
    push({ at: nowISO(), text: `扫描完成：${stash.files.length} 个文件，共 ${humanBytes(stash.bytes)}` })

    const needStash = plan.format !== 'copy'
    let sourceDir = plan.target
    if (needStash) {
      stashDir = path.join(os.tmpdir(), 'dsh-backup-' + run.id)
      await fs.mkdir(stashDir, { recursive: true })
      for (const file of stash.files) {
        const dest = path.join(stashDir, file.to.split('/').join(path.sep))
        await fs.mkdir(path.dirname(dest), { recursive: true })
        await fs.copyFile(file.from, dest)
      }
      push({ at: nowISO(), text: `暂存 ${stash.files.length} 个文件完成` })
      sourceDir = plan.target
    }

    if (plan.format === 'copy') {
      const result = await copyInto(plan, plan.target, stash, events)
      run.copied = result.copied
      run.unchanged = result.unchanged
      push({ at: nowISO(), text: `复制完成：新增/更新 ${result.copied} 个，未变化 ${result.unchanged} 个` })
    } else {
      if (plan.format === 'zip' && stash.bytes > 1.8 * 1024 * 1024 * 1024) {
        throw new Error('zip 单包上限约 2GB，请改用 tar.gz 或拆分来源')
      }
      run.archive = await makeArchive(plan, { files: stash.files, dir: stashDir }, sourceDir, events)
    }

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
    if (stashDir) fs.rm(stashDir, { recursive: true, force: true }).catch(() => {})
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

async function streamArchive(res, runId) {
  const state = loadState()
  const run = state.runs.find((item) => item.id === runId)
  const file = run && run.archive && run.archive.path
  if (!file) {
    sendJSON(res, 404, { ok: false, error: '找不到这个备份包' })
    return
  }
  let stat
  try {
    stat = await fs.stat(file)
  } catch {
    sendJSON(res, 404, { ok: false, error: '备份包已被移动或删除' })
    return
  }
  res.writeHead(200, {
    'content-type': run.archive.kind === 'zip' ? 'application/zip' : 'application/gzip',
    'content-length': stat.size,
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
    'cache-control': 'no-store',
  })
  fsSync.createReadStream(file).pipe(res)
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
      const result = await runPlan(plan, body.trigger === 'scheduled' ? 'scheduled' : 'manual')
      sendJSON(res, result.ok ? 200 : 400, result)
    }],
    [ROOT + '/stop', async (req, res) => {
      sendJSON(res, 200, { ok: true, note: '当前版本的备份任务会自行收尾，无法中途打断' })
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
          unchanged: ACTIVE.unchanged,
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
      spawn(cmd, [target], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
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
    [ROOT + '/download', async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      await streamArchive(res, url.searchParams.get('run'))
    }],
    [ROOT + '/health', async (req, res) => {
      sendJSON(res, 200, { ok: true, name, pid: process.pid, uptime: Math.round(process.uptime()) })
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
