// 冒烟测试：不依赖 DSH 运行时，用真实 HTTP 服务器加载插件并跑完整备份。
// 运行：node test/smoke.mjs
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-backup-home-'))
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-backup-work-'))
process.env.DSH_HOME = home

const srcA = path.join(work, 'a', 'docs')
const srcB = path.join(work, 'b', 'docs')
const target = path.join(work, 'target')
await fs.mkdir(srcA, { recursive: true })
await fs.mkdir(srcB, { recursive: true })
await fs.writeFile(path.join(srcA, 'one.txt'), 'A1')
await fs.writeFile(path.join(srcB, 'one.txt'), 'B1')
await fs.writeFile(path.join(srcB, 'two.txt'), 'B2')
await fs.mkdir(path.join(srcB, 'sub'), { recursive: true })
await fs.writeFile(path.join(srcB, 'sub', 'deep.txt'), 'B3')

const routes = new Map()
const ctx = {
  webServer: {
    register(entry) {
      routes.set(entry.path, entry.handler)
      return () => routes.delete(entry.path)
    },
  },
  effect(fn) {
    fn()
    return () => {}
  },
  logger: { warn() {}, info() {}, error() {} },
  on() {},
  get() {},
  set() {},
  provide() {},
}

const mod = await import(pathToFileURL(path.join(root, 'lib/index.js')).href)
mod.apply(ctx, {})

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const handler = routes.get(url.pathname)
  if (!handler) {
    res.writeHead(404).end('{}')
    return
  }
  await handler(req, res)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

const call = async (method, p, body) => {
  const res = await fetch(base + p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, data: await res.json() }
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const plan = (extra) => ({
  id: 'p1',
  name: '文档',
  enabled: true,
  intervalMinutes: 60,
  format: 'copy',
  source: srcA,
  target,
  exclude: [],
  keep: 5,
  verify: true,
  window: { enabled: false, start: '00:00', end: '23:59' },
  ...extra,
})

try {
  const saved = await call('PUT', '/dsh-backup/config', { enabled: true, tickSeconds: 30, plans: [plan()] })
  check('写入配置', saved.status === 200 && saved.data.ok !== false)

  const first = await call('POST', '/dsh-backup/run', { planId: 'p1' })
  check('首次备份成功', first.data.ok === true && first.data.run.status === 'success', JSON.stringify(first.data).slice(0, 160))

  const entries = await fs.readdir(target)
  check('复制模式直接铺在目标根目录', entries.includes('one.txt'), entries.join(' , '))

  const aContent = await fs.readFile(path.join(target, 'one.txt'), 'utf8')
  check('文件内容正确', aContent === 'A1', aContent)

  // 删掉目标文件后重跑，全量备份必须补回来（旧实现会因“大小相同”跳过）
  const victim = path.join(target, 'one.txt')
  await fs.rm(victim, { force: true })
  const second = await call('POST', '/dsh-backup/run', { planId: 'p1' })
  const restored = await fs.readFile(victim, 'utf8').catch(() => '')
  check('第二次仍为全量（删掉的文件会补回）', second.data.ok === true && second.data.run.status === 'success' && restored.length > 0, restored)

  const third = await call('POST', '/dsh-backup/run', { planId: 'p1' })
  check('每次都重写全部文件', third.data.run && third.data.run.copied === 1, 'copied=' + (third.data.run && third.data.run.copied))

  // 复制模式不再产生元数据目录（历史上会写 .dsh-backup/snapshot.json）
  check('复制模式不生成 .dsh-backup 元数据', !entries.includes('.dsh-backup'), entries.join(','))

  // 压缩模式命名
  const zipped = await call('PUT', '/dsh-backup/config', {
    enabled: true,
    tickSeconds: 30,
    plans: [plan({ id: 'p2', name: '压缩', format: 'zip', source: srcA, target: path.join(work, 'zips') })],
  })
  check('切换到 zip 计划', zipped.status === 200)
  const zrun = await call('POST', '/dsh-backup/run', { planId: 'p2' })
  const zipFiles = await fs.readdir(path.join(work, 'zips')).catch(() => [])
  check('zip 包名符合「计划名-时间.zip」', /^压缩-\d{8}-\d{6}\.zip$/.test(zipFiles[0] || ''), String(zipFiles[0]))
  check('zip 备份成功并通过校验', zrun.data.ok === true && Boolean(zrun.data.run && zrun.data.run.verify && zrun.data.run.verify.ok))

  // v1 的多来源计划：加载时拆成多个单选计划，不丢配置
  const legacy = await call('PUT', '/dsh-backup/config', {
    enabled: true,
    tickSeconds: 30,
    plans: [{ ...plan({ id: 'p3' }), source: undefined, sources: [srcA, srcB] }],
  })
  const mgPlans = (legacy.data.config && legacy.data.config.plans) || []
  check(
    '多来源旧配置被拆成两个单选计划',
    mgPlans.length === 2 &&
      mgPlans.every((p) => typeof p.source === 'string' && p.source && !Array.isArray(p.sources)) &&
      mgPlans.map((p) => p.name).join(',') === '文档-1,文档-2',
    mgPlans.map((p) => p.name + ':' + p.source).join(' | '),
  )
  // ---------------- 恢复：在线恢复到指定目录 ----------------
  const restoreDest = path.join(work, 'restored')
  const r1 = await call('POST', '/dsh-backup/restore', { runId: zrun.data.run.id, dest: restoreDest })
  const restoredOne = await fs.readFile(path.join(restoreDest, 'one.txt'), 'utf8').catch(() => '')

  check('在线恢复到指定目录', r1.data.ok === true && r1.data.restored === 1 && restoredOne === 'A1', JSON.stringify(r1.data).slice(0, 140))

  // ---------------- 恢复：生成离线脚本 ----------------
  const ex = await call('POST', '/dsh-backup/restore/export', { runId: zrun.data.run.id, mode: 'skip' })
  const exFiles = ex.data.ok ? await fs.readdir(ex.data.dir) : []
  check('离线恢复脚本三件套齐全', ['plan.json', 'restore.ps1', 'run.cmd'].every((f) => exFiles.includes(f)), exFiles.join(','))
  const exPlan = ex.data.ok ? JSON.parse(await fs.readFile(path.join(ex.data.dir, 'plan.json'), 'utf8')) : {}
  check(
    '离线脚本记录了来源与备份包',
    exPlan.source === srcA && Boolean(exPlan.archive && exPlan.archive.path),
    JSON.stringify(exPlan.source || null),
  )

  // ---------------- 恢复：被占用时按 skip 策略跳过 ----------------
  const lockFile = path.join(srcA, 'one.txt')
  await fs.writeFile(lockFile, 'A1')
  const psLit = (t) => "'" + String(t).replace(/'/g, "''") + "'"
  const locker = spawn(
    'powershell.exe',
    ['-NoProfile', '-Command', `$fs=[System.IO.File]::Open(${psLit(lockFile)},'Open','ReadWrite','None'); Start-Sleep -Seconds 20; $fs.Close()`],
    { windowsHide: true },
  )
  await new Promise((resolve) => setTimeout(resolve, 3000))
  const locked = await call('POST', '/dsh-backup/restore', { runId: zrun.data.run.id, mode: 'skip' })
  check(
    '被占用文件按 skip 策略跳过',
    locked.data.ok === true && locked.data.restored === 0 && (locked.data.skipped || []).length === 1,
    JSON.stringify(locked.data).slice(0, 160),
  )
  try { locker.kill() } catch { /* ignore */ }

  // ---------------- 离线脚本端到端：删掉源文件，直接跑 restore.ps1 ----------------
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const killTarget = path.join(srcA, 'one.txt')
  await fs.rm(killTarget, { force: true })
  const psRun = await new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ex.data.dir, 'restore.ps1')],
      { windowsHide: true },
    )
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', (code) => resolve({ code, out }))
  })
  const back = await fs.readFile(killTarget, 'utf8').catch(() => '')
  const psResult = JSON.parse(await fs.readFile(path.join(ex.data.dir, 'result.json'), 'utf8').catch(() => '{}'))
  check('离线脚本真正把文件恢复回来', back === 'A1' && psResult.restored === 1, back + ' / ' + (psRun.out || '').slice(-120))

  // ---------------- zip 归档必须保留子目录结构（回归：拍平会丢层级） ----------------
  const structZip = await call('PUT', '/dsh-backup/config', {
    enabled: true,
    tickSeconds: 30,
    plans: [plan({ id: 'p4', name: '结构', format: 'zip', source: srcB, target: path.join(work, 'zips2') })],
  })
  const sz = await call('POST', '/dsh-backup/run', { planId: 'p4' })
  const szDest = path.join(work, 'bz')
  const szRestore = await call('POST', '/dsh-backup/restore', { runId: sz.data.run && sz.data.run.id, dest: szDest })
  const deep = await fs.readFile(path.join(szDest, 'sub', 'deep.txt'), 'utf8').catch(() => '')
  check(
    'zip 保留子目录结构',
    structZip.status === 200 && szRestore.data.ok === true && szRestore.data.total === 3 && deep === 'B3',
    'total=' + (szRestore.data.total || 0) + ' deep=' + deep,
  )

} finally {
  await new Promise((resolve) => server.close(resolve))
  // Windows 上偶发 ENOTEMPTY（杀软/索引器短暂持有），失败不影响结论
  await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
  await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exitCode = failed.length ? 1 : 0
