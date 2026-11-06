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
  format: 'zip',
  sources: [srcA, srcB],
  target,
  exclude: [],
  keep: 5,
  verify: true,
  ...extra,
})

// 备份改成了后台执行：POST 只返回“已开始”，这里等它跑完再从历史里取结果，
// 保持与旧的同步返回同形状，断言不用改。
async function startRun(planId) {
  const res = await call('POST', '/dsh-backup/run', { planId })
  if (!res.data || !res.data.ok) return res
  for (let i = 0; i < 2000; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    const prog = await call('GET', '/dsh-backup/progress')
    if (!prog.data || !prog.data.running) break
  }
  const hist = await call('GET', '/dsh-backup/history')
  const run = (hist.data.runs || []).find((item) => item.planId === planId)
  const ok = Boolean(run && run.status === 'success')
  return { status: ok ? 200 : 400, data: { ok, run: run || null, error: (run && run.error) || '' } }
}

try {
  const saved = await call('PUT', '/dsh-backup/config', { enabled: true, tickSeconds: 30, plans: [plan()] })
  check('写入配置', saved.status === 200 && saved.data.ok !== false)

  const first = await startRun('p1')
  check('首次备份成功', first.data.ok === true && first.data.run.status === 'success', JSON.stringify(first.data).slice(0, 160))

  const entries = await fs.readdir(target)
  const zips = entries.filter((name) => /^文档-\d{8}-\d{6}(-\d+)?\.zip$/.test(name))
  check('产物是「计划名-时间戳.zip」，一次运行一个包', zips.length === 1, entries.join(' , '))
  check('空间预检留了日志', (first.data.run.log || []).some((l) => /空间预检/.test(l.text)))

  const stageLeft = await fs.readdir(path.join(process.env.DSH_HOME, 'backup-stage')).catch(() => [])
  check('成功后清空暂存目录', stageLeft.length === 0, stageLeft.join(' , '))

  const second = await startRun('p1')
  const afterSecond = (await fs.readdir(target)).filter((n) => /^文档-\d{8}-\d{6}(-\d+)?\.zip$/.test(n))
  check('再次运行生成新包且不覆盖旧备份', second.data.ok === true && afterSecond.length === 2, afterSecond.join(' , '))

  await fs.mkdir(path.join(target, '.dsh-backup'), { recursive: true })
  await fs.writeFile(path.join(target, '.dsh-backup', 'snapshot.json'), '{}')
  await startRun('p1')
  check('清理历史遗留的 .dsh-backup', !(await fs.readdir(target)).includes('.dsh-backup'))

  await call('PUT', '/dsh-backup/config', { enabled: true, tickSeconds: 30, plans: [plan({ keep: 2 })] })
  const fourth = await startRun('p1')
  const afterRotate = (await fs.readdir(target)).filter((n) => /^文档-\d{8}-\d{6}(-\d+)?\.zip$/.test(n))
  check(
    '按保留份数轮转',
    afterRotate.length === 2 && (fourth.data.run.rotated || []).length >= 1,
    afterRotate.join(' , ') + ' rotated=' + JSON.stringify(fourth.data.run.rotated || []),
  )

  await call('PUT', '/dsh-backup/config', {
    enabled: true,
    tickSeconds: 30,
    plans: [plan({ target: path.join(work, 'space'), reserveMb: 1048576 })],
  })
  const noSpace = await startRun('p1')
  check(
    '空间不足时提前拒绝',
    noSpace.data.ok === false && /空间不足/.test(String((noSpace.data.run && noSpace.data.run.error) || '')),
    String((noSpace.data.run && noSpace.data.run.error) || '').slice(0, 60),
  )

  const legacyCopy = await call('PUT', '/dsh-backup/config', {
    enabled: true,
    tickSeconds: 30,
    plans: [plan({ id: 'p7', format: 'copy', sources: [srcA] })],
  })
  const p7 = ((legacyCopy.data.config && legacyCopy.data.config.plans) || []).find((p) => p.id === 'p7')
  check('复制目录格式被归一化为 zip', Boolean(p7) && p7.format === 'zip', p7 && p7.format)

  // tar.gz：参数必须按 tar 实现动态拼接（GNU 要 --force-local，bsdtar 不能带）
  // 回归：中文文件名不能走 -T 清单，bsdtar 会按系统 ANSI 码页解析成空串
  const srcU = path.join(work, 'a', '中文目录')
  await fs.mkdir(srcU, { recursive: true })
  await fs.writeFile(path.join(srcU, '词典-来源.txt'), 'U1')
  await call('PUT', '/dsh-backup/config', {
    enabled: true,
    tickSeconds: 30,
    plans: [plan({ id: 'p6', name: '打包', format: 'tar.gz', sources: [srcA, srcU], target: path.join(work, 'tgz') })],
  })
  const tgzRun = await startRun('p6')
  const tgzFiles = await fs.readdir(path.join(work, 'tgz')).catch(() => [])
  check(
    'tar.gz 备份成功且命名正确',
    tgzRun.data.ok === true && /^打包-\d{8}-\d{6}\.tar\.gz$/.test(tgzFiles[0] || ''),
    String(tgzFiles[0]) + ' ' + String(tgzRun.data.error || ''),
  )
  check(
    'tar.gz 含中文文件名也能打包并通过校验',
    Boolean(tgzRun.data.run && tgzRun.data.run.verify && tgzRun.data.run.verify.ok),
    JSON.stringify(tgzRun.data.run && tgzRun.data.run.verify),
  )
  // 回归：包内不能出现 "." 根条目或 "./" 前缀（解压工具会显示成多余的“本地磁盘”层）
  const runTar = (args) =>
    new Promise((resolve) => {
      const p = spawn('tar', args, { windowsHide: true })
      let out = ''
      p.stdout.on('data', (d) => (out += d))
      p.on('close', () => resolve(out.split(/\r?\n/).filter(Boolean)))
      p.on('error', () => resolve([]))
    })
  const archivePath = path.join(work, 'tgz', tgzFiles[0] || '')
  let listed = await runTar(['--force-local', '-tzf', archivePath])
  if (!listed.length) listed = await runTar(['-tzf', archivePath])
  check(
    'tar.gz 包内没有多余的点目录层',
    listed.length > 0 && listed.every((n) => n !== '.' && !n.startsWith('./')),
    listed.slice(0, 3).join(' | '),
  )

  // 压缩模式命名
  const zipped = await call('PUT', '/dsh-backup/config', {
    enabled: true,
    tickSeconds: 30,
    plans: [plan({ id: 'p2', name: '压缩', format: 'zip', sources: [srcA], target: path.join(work, 'zips') })],
  })
  check('切换到 zip 计划', zipped.status === 200)
  const zrun = await startRun('p2')
  const zipFiles = await fs.readdir(path.join(work, 'zips')).catch(() => [])
  check('zip 包名符合「计划名-时间.zip」', /^压缩-\d{8}-\d{6}\.zip$/.test(zipFiles[0] || ''), String(zipFiles[0]))
  check('zip 备份成功并通过校验', zrun.data.ok === true && Boolean(zrun.data.run && zrun.data.run.verify && zrun.data.run.verify.ok))

  // 重复来源应当被拒绝
  const dup = await call('PUT', '/dsh-backup/config', {
    enabled: true,
    tickSeconds: 30,
    plans: [plan({ id: 'p3', sources: [srcA, srcA.toUpperCase()] })],
  })
  const dupRun = await startRun('p3')
  check('重复来源被拒绝', dup.status === 200 && dupRun.data.ok === false, String(dupRun.data.error || '').slice(0, 60))
  // ---------------- 恢复：在线恢复到指定目录 ----------------
  const restoreDest = path.join(work, 'restored')
  const r1 = await call('POST', '/dsh-backup/restore', { runId: zrun.data.run.id, dest: restoreDest })
  const restoredOne = await fs.readFile(path.join(restoreDest, 'docs', 'one.txt'), 'utf8').catch(() => '')

  check('在线恢复到指定目录', r1.data.ok === true && r1.data.restored === 1 && restoredOne === 'A1', JSON.stringify(r1.data).slice(0, 140))

  // ---------------- 恢复：生成离线脚本 ----------------
  const ex = await call('POST', '/dsh-backup/restore/export', { runId: zrun.data.run.id, mode: 'skip' })
  const exFiles = ex.data.ok ? await fs.readdir(ex.data.dir) : []
  check('离线恢复脚本三件套齐全', ['plan.json', 'restore.ps1', 'run.cmd'].every((f) => exFiles.includes(f)), exFiles.join(','))
  const exPlan = ex.data.ok ? JSON.parse(await fs.readFile(path.join(ex.data.dir, 'plan.json'), 'utf8')) : {}
  check(
    '离线脚本记录了来源映射与备份包',
    Array.isArray(exPlan.mapping) && exPlan.mapping[0] && exPlan.mapping[0].label === 'docs' && Boolean(exPlan.archive && exPlan.archive.path),
    JSON.stringify(exPlan.mapping || null),
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

  // ---------------- 0.3.0 写出的单选配置（plan.source）必须能继续读入 ----------------
  const legacySingle = await call('PUT', '/dsh-backup/config', {
    enabled: true,
    tickSeconds: 30,
    plans: [{ id: 'p5', name: '旧单选', source: srcA, target: path.join(work, 'legacy'), format: 'copy', sources: undefined }],
  })
  const lg = legacySingle.data.config.plans.find((p) => p.id === 'p5')
  check('旧的单选 plan.source 配置被读成单元素 sources', Boolean(lg) && Array.isArray(lg.sources) && lg.sources.length === 1, JSON.stringify(lg && lg.sources))
  check(
    '缺字段的间隔与保留份数用明确默认（每天 / 7 份）',
    Boolean(lg) && lg.intervalMinutes === 1440 && lg.keep === 7,
    lg ? `interval=${lg.intervalMinutes} keep=${lg.keep}` : 'null',
  )


  const bothZip = await call('PUT', '/dsh-backup/config', {
    enabled: true,
    tickSeconds: 30,
    plans: [plan({ id: 'p4', name: '双源', format: 'zip', sources: [srcA, srcB], target: path.join(work, 'zips2') })],
  })
  const bz = await startRun('p4')
  const bzDest = path.join(work, 'bz')
  const bzRestore = await call('POST', '/dsh-backup/restore', { runId: bz.data.run && bz.data.run.id, dest: bzDest })
  const bzDirs = await fs.readdir(bzDest).catch(() => [])
  check(
    'zip 保留来源目录、同名文件不互相覆盖',
    bothZip.status === 200 && bzRestore.data.ok === true && bzDirs.length === 2 && bzRestore.data.total === 3,
    bzDirs.join(' , ') + ' total=' + (bzRestore.data.total || 0),
  )

  // 备份结束（无论成功失败）都要清空暂存，不留临时文件
  const blocker = path.join(work, 'blocker')
  await fs.writeFile(blocker, 'x')
  await call('PUT', '/dsh-backup/config', {
    enabled: true,
    tickSeconds: 30,
    plans: [plan({ id: 'p8', name: '续传', format: 'zip', sources: [srcA], target: blocker })],
  })
  const failedRun = await startRun('p8')
  const keptStage = await fs.readdir(path.join(process.env.DSH_HOME, 'backup-stage', 'p8')).catch(() => [])
  check(
    '失败后暂存目录也被清空',
    failedRun.data.ok === false && keptStage.length === 0,
    String(keptStage.length) + ' ' + String(failedRun.data.run && failedRun.data.run.error),
  )

  // ---------------- 暂存目录可配置 + 一键清理 ----------------
  const customStage = path.join(work, 'mystage')
  const staged = await call('PUT', '/dsh-backup/config', {
    enabled: true,
    tickSeconds: 30,
    stageRoot: customStage,
    plans: [plan({ id: 'p9', name: '暂存可配', format: 'zip', sources: [srcA], target: path.join(work, 'stg') })],
  })
  check(
    '暂存目录可配置并持久化',
    staged.status === 200 && staged.data.config && staged.data.config.stageRoot === customStage,
    String(staged.data.config && staged.data.config.stageRoot),
  )
  // 暂存目录可以换到别处；备份时用这里暂存，结束后自动清空（不需要手动清理按钮）
  await fs.mkdir(path.join(customStage, 'p9'), { recursive: true })
  await fs.writeFile(path.join(customStage, 'p9', 'leftover.bin'), 'x'.repeat(4096))
  await startRun('p9')
  const afterRun = await fs.readdir(customStage).catch(() => [])
  check(
    '备份结束后自动清空暂存（含上次残留）',
    afterRun.length === 0,
    JSON.stringify(afterRun),
  )
  await fs.rm(customStage, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  const risky = await call('PUT', '/dsh-backup/config', {
    enabled: true,
    tickSeconds: 30,
    stageRoot: 'C:\\Users',
    plans: [plan({ id: 'p9', name: '暂存可配', format: 'zip', sources: [srcA], target: path.join(work, 'stg') })],
  })
  check(
    '用户目录的上级目录不会被当成暂存目录',
    risky.status === 200 && risky.data.config.stageRoot !== 'C:\\Users',
    String(risky.data.config.stageRoot),
  )

  // 暂存目录与来源目录互相嵌套必须被拒（否则备份会把自己打进去，或清理时删掉来源）
  await call('PUT', '/dsh-backup/config', {
    enabled: true,
    tickSeconds: 30,
    stageRoot: path.join(work, 'a', 'docs', '.stage'),
    plans: [plan({ id: 'p10', name: '嵌套暂存', format: 'zip', sources: [srcA], target: path.join(work, 'nest') })],
  })
  // 暂存在来源内部（例如来源是 ~/.dsh、暂存在 ~/.dsh/backup-stage）是允许的：
  // 扫描会跳过暂存目录，这里预先塞一个残留文件验证它进不了包。
  await fs.mkdir(path.join(work, 'a', 'docs', '.stage', 'p10'), { recursive: true })
  await fs.writeFile(path.join(work, 'a', 'docs', '.stage', 'p10', 'leftover.bin'), 'x'.repeat(2048))
  const nestedRun = await startRun('p10')
  // 只备份了 one.txt（2 字节）；若 .stage 里的 2KB 残留被扫进去，bytes 会明显变大
  check(
    '暂存目录位于来源内部时照常备份且跳过暂存内容',
    nestedRun.data.ok === true
      && nestedRun.data.run
      && nestedRun.data.run.status === 'success'
      && nestedRun.data.run.bytes === 2,
    'bytes=' + (nestedRun.data.run && nestedRun.data.run.bytes) + ' status=' + (nestedRun.data.run && nestedRun.data.run.status),
  )
  await call('PUT', '/dsh-backup/config', {
    enabled: true,
    tickSeconds: 30,
    stageRoot: path.join(work, 'a', 'docs'),
    plans: [plan({ id: 'p11', name: '来源在暂存内', format: 'zip', sources: [path.join(work, 'a', 'docs', 'sub')], target: path.join(work, 'nest2') })],
  })
  const insideRun = await call('POST', '/dsh-backup/run', { planId: 'p11' })
  check(
    '来源目录位于暂存目录内部时拒绝运行',
    insideRun.data.ok === false && /来源目录不能位于暂存目录内部/.test(String(insideRun.data.error || '')),
    String(insideRun.data.error || ''),
  )

  // 立即备份必须立刻返回“已开始”，而不是等备份跑完（关掉设置页不影响后台任务）
  await call('PUT', '/dsh-backup/config', {
    enabled: true,
    tickSeconds: 30,
    plans: [plan({ id: 'p8', name: '续传', format: 'zip', sources: [srcA], target: blocker })],
  })
  const kicked = await call('POST', '/dsh-backup/run', { planId: 'p8' })
  check(
    '立即备份接口立刻返回“已开始”',
    kicked.status === 202 && kicked.data.started === true,
    JSON.stringify(kicked.data).slice(0, 120),
  )
  for (let i = 0; i < 600; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    const prog = await call('GET', '/dsh-backup/progress')
    if (!prog.data || !prog.data.running) break
  }
  const idleStop = await call('POST', '/dsh-backup/stop', {})
  check(
    '空闲时停止接口直接返回',
    idleStop.data.ok === true && idleStop.data.running === false,
    JSON.stringify(idleStop.data).slice(0, 120),
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
