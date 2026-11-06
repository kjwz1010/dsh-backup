// 冒烟测试：不依赖 DSH 运行时，用真实 HTTP 服务器加载插件并跑完整备份。
// 运行：node test/smoke.mjs
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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
  format: 'copy',
  sources: [srcA, srcB],
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
  const dirs = entries.filter((name) => name.startsWith('docs'))
  check('同名来源被区分为两个目录', dirs.length === 2, dirs.join(' , '))

  const aDir = dirs.find((name) => name.includes('-'))
  check('重名目录带哈希后缀', Boolean(aDir) && /^docs-[0-9a-f]{6}$/.test(aDir), String(aDir))

  const all = []
  for (const dir of dirs) {
    for (const name of await fs.readdir(path.join(target, dir))) all.push(dir + '/' + name)
  }
  check('三个文件全部落盘', all.length === 3, all.join(' , '))

  const aContent = await fs.readFile(path.join(target, dirs.find((d) => d !== 'docs') || dirs[0], 'one.txt'), 'utf8')
  check('同名文件内容没有互相覆盖', ['A1', 'B1'].includes(aContent), aContent)

  // 删掉目标文件后重跑，全量备份必须补回来（旧实现会因“大小相同”跳过）
  const victim = path.join(target, dirs[0], 'one.txt')
  await fs.rm(victim, { force: true })
  const second = await call('POST', '/dsh-backup/run', { planId: 'p1' })
  const restored = await fs.readFile(victim, 'utf8').catch(() => '')
  check('第二次仍为全量（删掉的文件会补回）', second.data.ok === true && second.data.run.status === 'success' && restored.length > 0, restored)

  const third = await call('POST', '/dsh-backup/run', { planId: 'p1' })
  check('每次都重写全部文件', third.data.run && third.data.run.copied === 3, 'copied=' + (third.data.run && third.data.run.copied))

  // 压缩模式命名
  const zipped = await call('PUT', '/dsh-backup/config', {
    enabled: true,
    tickSeconds: 30,
    plans: [plan({ id: 'p2', name: '压缩', format: 'zip', sources: [srcA], target: path.join(work, 'zips') })],
  })
  check('切换到 zip 计划', zipped.status === 200)
  const zrun = await call('POST', '/dsh-backup/run', { planId: 'p2' })
  const zipFiles = await fs.readdir(path.join(work, 'zips')).catch(() => [])
  check('zip 包名符合「计划名-时间.zip」', /^压缩-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.zip$/.test(zipFiles[0] || ''), String(zipFiles[0]))
  check('zip 备份成功并通过校验', zrun.data.ok === true && Boolean(zrun.data.run && zrun.data.run.verify && zrun.data.run.verify.ok))

  // 重复来源应当被拒绝
  const dup = await call('PUT', '/dsh-backup/config', {
    enabled: true,
    tickSeconds: 30,
    plans: [plan({ id: 'p3', sources: [srcA, srcA.toUpperCase()] })],
  })
  const dupRun = await call('POST', '/dsh-backup/run', { planId: 'p3' })
  check('重复来源被拒绝', dup.status === 200 && dupRun.data.ok === false, String(dupRun.data.error || '').slice(0, 60))
} finally {
  await new Promise((resolve) => server.close(resolve))
  await fs.rm(home, { recursive: true, force: true })
  await fs.rm(work, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exitCode = failed.length ? 1 : 0
