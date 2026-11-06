// DSH「定时备份」· 设置页半边
//
// 挂在「设置 → 备份」里：增删改备份计划、选来源/目标目录、立刻跑一次、看历史与日志、从备份点恢复。
// 接口（都挂在宿主半边的 /dsh-backup 下）：
//   GET  /dsh-backup                 读配置 + 状态 + 历史
//   PUT  /dsh-backup/config          写配置（整份）
//   POST /dsh-backup/run             立刻备份一次（跑完才返回）
//   POST /dsh-backup/stop            停止正在执行的备份
//   GET  /dsh-backup/progress        正在跑的备份进度（轮询）
//   POST /dsh-backup/open            调系统目录选择窗口
//   POST /dsh-backup/reveal          在文件管理器里打开目录
//   POST /dsh-backup/history/clear   清空历史
//   POST /dsh-backup/restore         在线恢复
//   POST /dsh-backup/restore/export  生成离线恢复脚本
//   GET  /dsh-backup/restore/progress 正在跑的恢复进度（轮询）
//   GET  /dsh-backup/restore/result  最近一次离线恢复的结果
window.__ModuleLoader__.load({
  id: 'dsh-backup',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const { useState, useEffect, useRef } = React
    const h = React.createElement
    const inject = ['slots']
    const B = '/dsh-backup'

    const get = (p) => fetch(B + p, { cache: 'no-store' }).then((r) => r.json())
    const send = (method, p, body) =>
      fetch(B + p, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }).then((r) => r.json())

    const S = {
      wrap: { padding: '4px 0 20px' },
      title: { fontSize: 16, fontWeight: 600, margin: '0 0 4px' },
      sub: { fontSize: 12, opacity: 0.62, margin: '0 0 16px', lineHeight: 1.75 },
      row: { display: 'flex', alignItems: 'flex-start', gap: 10, margin: '0 0 10px' },
      label: { fontSize: 13, width: 74, flex: '0 0 74px', opacity: 0.82, lineHeight: '28px' },
      control: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0, flex: 1 },
      input: {
        fontSize: 13,
        padding: '5px 9px',
        borderRadius: 6,
        border: '1px solid rgba(128,128,128,.35)',
        background: 'transparent',
        color: 'inherit',
        minWidth: 200,
        boxSizing: 'border-box',
      },
      num: {
        fontSize: 13,
        padding: '5px 8px',
        borderRadius: 6,
        border: '1px solid rgba(128,128,128,.35)',
        background: 'transparent',
        color: 'inherit',
        width: 84,
        boxSizing: 'border-box',
      },
      card: {
        border: '1px solid rgba(128,128,128,.26)',
        borderRadius: 10,
        padding: '12px 14px 6px',
        margin: '0 0 12px',
        minWidth: 0,
      },
      btn: {
        fontSize: 12,
        padding: '4px 10px',
        borderRadius: 6,
        border: '1px solid rgba(128,128,128,.38)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      btnMain: {
        fontSize: 12,
        padding: '5px 12px',
        borderRadius: 6,
        border: '1px solid rgba(128,128,128,.45)',
        background: 'rgba(128,128,128,.14)',
        color: 'inherit',
        cursor: 'pointer',
        fontWeight: 600,
        whiteSpace: 'nowrap',
      },
      btnOn: {
        fontSize: 12,
        padding: '4px 10px',
        borderRadius: 6,
        border: '1px solid rgba(90,140,255,.6)',
        background: 'rgba(90,140,255,.16)',
        color: 'inherit',
        cursor: 'pointer',
      },
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12,
        padding: '3px 6px 3px 9px',
        borderRadius: 999,
        border: '1px solid rgba(128,128,128,.35)',
        maxWidth: 360,
      },
      x: { cursor: 'pointer', opacity: 0.6, fontSize: 13, padding: '0 2px' },
      hint: { fontSize: 12, opacity: 0.6, lineHeight: 1.8 },
      err: { fontSize: 12, color: '#d9534f', lineHeight: 1.7 },
      ok: { fontSize: 12, color: '#3fa45b', lineHeight: 1.7 },
      info: { fontSize: 12, opacity: 0.75, lineHeight: 1.7 },
      pre: {
        fontSize: 11.5,
        lineHeight: 1.7,
        fontFamily: 'ui-monospace, Consolas, monospace',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        maxHeight: 220,
        overflow: 'auto',
        margin: '6px 0 0',
        padding: '8px 10px',
        borderRadius: 8,
        border: '1px solid rgba(128,128,128,.22)',
      },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
      th: { textAlign: 'left', fontWeight: 600, opacity: 0.65, padding: '6px 8px', borderBottom: '1px solid rgba(128,128,128,.25)' },
      td: { padding: '6px 8px', borderBottom: '1px solid rgba(128,128,128,.14)', verticalAlign: 'top' },
      link: { color: 'inherit', textDecoration: 'underline', cursor: 'pointer', opacity: 0.85 },
    }

    // 备份是整包全量，十几分钟一跑没意义；只留真用得上的几档，其余用「自定义」。
    const PRESETS = [
      [60, '每小时'],
      [1440, '每天'],
      [10080, '每周'],
    ]
    const FORMAT_LABEL = { zip: 'ZIP 包（≤2GB）', 'tar.gz': 'TAR.GZ 包（不限大小）' }

    function fmtBytes(n) {
      const v = Number(n) || 0
      if (v < 1024) return v + ' B'
      if (v < 1048576) return (v / 1024).toFixed(1) + ' KB'
      if (v < 1073741824) return (v / 1048576).toFixed(1) + ' MB'
      return (v / 1073741824).toFixed(2) + ' GB'
    }

    function fmtTime(iso) {
      if (!iso) return '—'
      const d = new Date(iso)
      if (isNaN(d.getTime())) return String(iso)
      const p = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    }

    function fmtGap(ms) {
      const v = Math.max(0, Number(ms) || 0)
      if (v < 60000) return '不到 1 分钟'
      if (v < 3600000) return Math.round(v / 60000) + ' 分钟'
      if (v < 86400000) return (v / 3600000).toFixed(1) + ' 小时'
      return (v / 86400000).toFixed(1) + ' 天'
    }

    function intervalText(minutes) {
      const m = Number(minutes) || 0
      if (m >= 10080 && m % 10080 === 0) return (m / 10080 === 1 ? '每' : '每 ' + m / 10080 + ' ') + '周'
      if (m >= 1440 && m % 1440 === 0) return (m / 1440 === 1 ? '每' : '每 ' + m / 1440 + ' ') + '天'
      if (m >= 60 && m % 60 === 0) return (m / 60 === 1 ? '每' : '每 ' + m / 60 + ' ') + '小时'
      return '每 ' + m + ' 分钟'
    }

    function toDraft(config) {
      const plans = (config.plans || []).map((plan) =>
        Object.assign({}, plan, {
          exclude: Array.isArray(plan.exclude) ? plan.exclude.join(', ') : String(plan.exclude || ''),
        }),
      )
      return { enabled: config.enabled !== false, tickSeconds: config.tickSeconds || 30, stageRoot: config.stageRoot || '', plans }
    }

    function fromDraft(draft) {
      return {
        enabled: draft.enabled !== false,
        tickSeconds: draft.tickSeconds || 30,
        stageRoot: String(draft.stageRoot || '').trim(),
        plans: (draft.plans || []).map((plan) => ({
          id: plan.id || '',
          name: plan.name,
          enabled: plan.enabled !== false,
          intervalMinutes: Number(plan.intervalMinutes) || 1440,
          format: plan.format,
          sources: plan.sources || [],
          target: plan.target || '',
          exclude: String(plan.exclude || '')
            .split(/[,，\n]/)
            .map((s) => s.trim())
            .filter(Boolean),
          keep: Number(plan.keep) || 7,
          verify: plan.verify !== false,
        })),
      }
    }

    function Row(props) {
      return h('div', { style: S.row }, h('div', { style: S.label }, props.label), h('div', { style: S.control }, props.children))
    }

    function Check(props) {
      return h(
        'label',
        { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, cursor: 'pointer', opacity: props.disabled ? 0.45 : 0.9 } },
        h('input', { type: 'checkbox', checked: !!props.checked, disabled: props.disabled, onChange: (e) => props.onChange(e.target.checked) }),
        props.text,
      )
    }

    // 原生 <select> 的弹出层会继承 S.input 的 transparent 背景，
    // 落到系统白底上再配主题的浅色文字，就成了白底白字。这里自己画一个。
    function Sel({ value, options, onChange, width }) {
      const [open, setOpen] = useState(false)
      const box = useRef(null)
      useEffect(() => {
        if (!open) return
        const off = (e) => { if (!box.current || !box.current.contains(e.target)) setOpen(false) }
        document.addEventListener('mousedown', off)
        return () => document.removeEventListener('mousedown', off)
      }, [open])
      const cur = options.find((o) => o.value === value) || options[0]
      return h('div', { ref: box, style: { position: 'relative', display: 'inline-block' } },
        h('button', {
          type: 'button',
          style: Object.assign({}, S.input, {
            width: width || 150, textAlign: 'left', cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          }),
          onClick: () => setOpen(!open),
        },
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, cur ? cur.text : ''),
          h('span', { style: { opacity: 0.55, flexShrink: 0 } }, open ? '\u25b4' : '\u25be'),
        ),
        open
          ? h('div', {
            style: {
              position: 'absolute', top: 'calc(100% + 4px)', left: 0, minWidth: '100%',
              maxHeight: 320, overflowY: 'auto', zIndex: 60,
              background: 'Canvas', color: 'CanvasText',
              border: '1px solid rgba(128,128,128,.45)', borderRadius: 6,
              boxShadow: '0 10px 28px rgba(0,0,0,.35)', padding: '4px 0',
            },
          }, options.map((o) => h('div', {
            key: o.value,
            onClick: () => { setOpen(false); if (o.value !== value) onChange(o.value) },
            style: {
              padding: '7px 12px', fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap',
              background: o.value === value ? 'rgba(90,140,255,.28)' : 'transparent',
            },
            onMouseEnter: (e) => { if (o.value !== value) e.currentTarget.style.background = 'rgba(128,128,128,.22)' },
            onMouseLeave: (e) => { if (o.value !== value) e.currentTarget.style.background = 'transparent' },
          }, o.text)))
          : null,
      )
    }

    function PlanCard(props) {
      const { plan, index, onChange, onDelete, onRun, onBrowse, running } = props
      const [newSource, setNewSource] = useState('')
      const patch = (p) => onChange(Object.assign({}, plan, p))
      const errors = plan.errors || []
      const isPreset = PRESETS.some(([v]) => v === Number(plan.intervalMinutes))
      // 「自定义」是一种显式选择：只靠“当前值不在预设里”推导，会让用户选了自定义、
      // 但数字恰好还是预设值时下拉框立刻跳回去，看起来像点了没反应。
      const [customMode, setCustomMode] = useState(!isPreset)
      const custom = customMode || !isPreset

      function addSource(text) {
        const value = String(text || '').trim()
        if (!value) return
        const sources = plan.sources || []
        if (sources.indexOf(value) === -1) patch({ sources: sources.concat([value]) })
        setNewSource('')
      }

      function removeSource(i) {
        patch({ sources: (plan.sources || []).filter((_, idx) => idx !== i) })
      }

      return h(
        'div',
        { style: S.card },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 } },
          h('input', {
            style: Object.assign({}, S.input, { minWidth: 180, flex: 1, fontWeight: 600 }),
            value: plan.name || '',
            placeholder: '计划名称',
            onChange: (e) => patch({ name: e.target.value }),
          }),
          h(Check, { checked: plan.enabled !== false, onChange: (v) => patch({ enabled: v }), text: '启用' }),
          h('button', { style: S.btn, onClick: () => onDelete(index) }, '删除'),
        ),

        h(
          Row,
          { label: '间隔' },
          h(Sel, {
            width: 150,
            value: custom ? 'custom' : String(plan.intervalMinutes),
            options: PRESETS.map(([value, text]) => ({ value: String(value), text }))
              .concat([{ value: 'custom', text: '自定义（分钟）' }]),
            onChange: (v) => {
              // 切到自定义时不动当前数值（「每天」进来就是 1440），用户接着往下改
              if (v === 'custom') setCustomMode(true)
              else { setCustomMode(false); patch({ intervalMinutes: Number(v) }) }
            },
          }),
          h('input', {
            style: S.num,
            type: 'number',
            min: 1,
            max: 43200,
            value: plan.intervalMinutes,
            onChange: (e) => patch({ intervalMinutes: Number(e.target.value) || 1 }),
          }),
          h('span', { style: S.hint }, '当前：' + intervalText(plan.intervalMinutes)),
        ),

        h(
          Row,
          { label: '打包方式' },
          Object.keys(FORMAT_LABEL).map((key) =>
            h(
              'button',
              {
                key,
                style: plan.format === key ? S.btnOn : S.btn,
                onClick: () => patch({ format: key }),
              },
              FORMAT_LABEL[key],
            ),
          ),
          h(
                'span',
                { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 } },
                '保留',
                h('input', {
                  style: S.num,
                  type: 'number',
                  min: 1,
                  max: 365,
                  value: plan.keep,
                  onChange: (e) => patch({ keep: Number(e.target.value) || 1 }),
                }),
                '份',
              ),
          h(
            'span',
            { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }, title: '给目标盘留的安全余量：不足这个空闲量就不会开始备份。填 0 表示只按本次备份大小估算' },
            '预留',
            h('input', {
              style: S.num,
              type: 'number',
              min: 0,
              max: 1048576,
              value: plan.reserveMb || 0,
              onChange: (e) => patch({ reserveMb: Math.max(0, Number(e.target.value) || 0) }),
            }),
            'MB',
          ),
          h(Check, { checked: plan.verify !== false, onChange: (v) => patch({ verify: v }), text: '备份后校验' }),
        ),

        h(
          Row,
          { label: '来源' },
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 0 } },
            h(
              'div',
              { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
              (plan.sources || []).length
                ? plan.sources.map((src, i) =>
                    h(
                      'span',
                      { key: src + i, style: S.chip, title: src },
                      h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, src),
                      h('span', { style: S.x, onClick: () => removeSource(i), title: '移除' }, '×'),
                    ),
                  )
                : h('span', { style: S.hint }, '还没有选择来源目录'),
            ),
            h(
              'div',
              { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
              h('input', {
                style: Object.assign({}, S.input, { flex: 1, minWidth: 220 }),
                placeholder: '粘贴目录路径，回车添加',
                value: newSource,
                onChange: (e) => setNewSource(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === 'Enter') addSource(newSource)
                },
              }),
              h('button', { style: S.btn, onClick: () => addSource(newSource) }, '添加'),
              h(
                'button',
                {
                  style: S.btn,
                  onClick: async () => {
                    const picked = await onBrowse('source')
                    if (picked) addSource(picked)
                  },
                },
                '浏览…',
              ),
            ),
            h(
              'div',
              { style: S.hint },
              (() => {
                const names = (plan.sources || []).map((s) => String(s).split(/[\\/]/).filter(Boolean).pop() || '')
                const dup = names.filter((n, i) => n && names.indexOf(n) !== i)
                if (!dup.length) return null
                const shown = Array.from(new Set(dup))
                return '检测到同名目录 ' + shown.join('、') + '：备份里会自动加路径哈希后缀（如 ' + shown[0] + '-1a2b3c）区分，不会互相覆盖。'
              })(),
            ),
          ),
        ),

        h(
          Row,
          { label: '目标' },
          h('input', {
            style: Object.assign({}, S.input, { flex: 1, minWidth: 240 }),
            placeholder: '完整路径，例如 D:\\Backup',
            value: plan.target || '',
            onChange: (e) => patch({ target: e.target.value }),
          }),
          h(
            'button',
            {
              style: S.btn,
              onClick: async () => {
                const picked = await onBrowse('target')
                if (picked) patch({ target: picked })
              },
            },
            '浏览…',
          ),
        ),

        h(
          Row,
          { label: '排除' },
          h('input', {
            style: Object.assign({}, S.input, { flex: 1, minWidth: 260 }),
            placeholder: '逗号分隔，支持 * 和 ?',
            title: '按文件名或目录名匹配，支持 * 和 ?，可写多级路径，如 docs/cache',
            value: plan.exclude || '',
            onChange: (e) => patch({ exclude: e.target.value }),
          }),
        ),

        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '4px 0 8px' } },
          h(
            'button',
            {
              style: running ? S.btn : S.btnMain,
              disabled: running,
              onClick: () => onRun(plan),
            },
            running ? '备份进行中…' : '立即备份一次',
          ),
          errors.length ? h('span', { style: S.err }, '⚠ ' + errors.join('；')) : null,
          !errors.length && plan.lastRunAt
            ? h('span', { style: S.hint }, '上次 ' + fmtTime(plan.lastRunAt) + ' · 下次约 ' + fmtTime(plan.nextRunAt))
            : null,
          !errors.length && !plan.lastRunAt ? h('span', { style: S.hint }, '还没跑过，保存后会自动开始第一次备份') : null,
        ),
      )
    }

    function RestorePanel(props) {
      const { run, onClose } = props
      const [dest, setDest] = useState('')
      const [mode, setMode] = useState('skip')
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState(null)
      const [exportDir, setExportDir] = useState('')

      const box = {
        margin: '2px 0 14px',
        padding: '12px 14px',
        borderRadius: 8,
        border: '1px solid rgba(128,128,128,.28)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }
      const note = { fontSize: 12, opacity: 0.62, lineHeight: 1.7 }

      const describe = (res) => {
        const parts = ['成功 ' + res.restored + ' 个']
        if ((res.skipped || []).length) parts.push('跳过 ' + res.skipped.length + ' 个（被占用）')
        if ((res.sideloaded || []).length) parts.push('旁路写入 ' + res.sideloaded.length + ' 个')
        if (res.undoDir) parts.push('撤销副本：' + res.undoDir)
        return parts.join('，')
      }

      const online = async () => {
        setBusy('online')
        setMsg(null)
        try {
          const res = await send('POST', '/restore', { runId: run.id, dest, mode })
          if (res && res.ok) setMsg({ kind: 'ok', text: '恢复完成：' + describe(res) })
          else setMsg({ kind: 'err', text: (res && res.error) || '恢复失败' })
        } catch (err) {
          setMsg({ kind: 'err', text: String((err && err.message) || err) })
        }
        setBusy('')
      }

      const offline = async () => {
        setBusy('offline')
        setMsg(null)
        try {
          const res = await send('POST', '/restore/export', { runId: run.id, dest, mode })
          if (res && res.ok) {
            setExportDir(res.dir)
            setMsg({ kind: 'ok', text: '已生成离线恢复脚本：关闭 DSH 后双击目录里的 run.cmd' })
          } else {
            setMsg({ kind: 'err', text: (res && res.error) || '生成失败' })
          }
        } catch (err) {
          setMsg({ kind: 'err', text: String((err && err.message) || err) })
        }
        setBusy('')
      }

      return h(
        'div',
        { style: box },
        h(
          'div',
          { style: S.row },
          h('div', { style: S.label }, '恢复到'),
          h(
            'div',
            { style: S.control },
            h('input', {
              style: S.input,
              placeholder: '留空 = 覆盖回备份时的原始目录',
              value: dest,
              onChange: (e) => setDest(e.target.value),
            }),
            h(
              'button',
              {
                style: S.btn,
                onClick: async () => {
                  const res = await send('POST', '/open', { kind: 'target' })
                  if (res && res.ok && res.path) setDest(res.path)
                },
              },
              '选择目录',
            ),
          ),
        ),
        h(
          'div',
          { style: S.row },
          h('div', { style: S.label }, '占用策略'),
          h(
            'div',
            { style: S.control },
            h(Sel, {
              width: 320,
              value: mode,
              options: [
                { value: 'skip', text: '跳过被占用的，继续恢复其它（推荐）' },
                { value: 'sideload', text: '写到旁边，文件名加 .restore-时间戳' },
                { value: 'strict', text: '遇到占用就整体中止' },
              ],
              onChange: setMode,
            }),
          ),
        ),
        h(
          'div',
          { style: S.control },
          h('button', { style: S.btn, disabled: !!busy, onClick: online }, busy === 'online' ? '恢复中…' : '立即恢复'),
          h('button', { style: S.btn, disabled: !!busy, onClick: offline }, busy === 'offline' ? '生成中…' : '生成离线恢复脚本'),
          exportDir
            ? h(
                'button',
                { style: S.btn, onClick: () => send('POST', '/reveal', { path: exportDir }) },
                '打开脚本所在目录',
              )
            : null,
          h('span', { style: S.link, onClick: onClose }, '收起'),
        ),
        h('div', { style: note }, '如果文件被 DSH 自己占用（工作区文件、插件文件），在线恢复通常会失败。改用「生成离线恢复脚本」：关掉 DSH 后双击 run.cmd，脚本会等锁释放再恢复。'),
        exportDir ? h('div', { style: S.hint }, exportDir) : null,
        msg ? h('div', { style: msg.kind === 'ok' ? S.ok : S.err }, msg.text) : null,
      )
    }

    function History(props) {
      const { runs, openLog, setOpenLog, notify } = props
      const [restoreRun, setRestoreRun] = useState('')
      if (!runs.length) return h('div', { style: S.hint }, '还没有备份记录。')
      return h(
        'div',
        { style: { overflowX: 'auto' } },
        h(
          'table',
          { style: S.table },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              ['完成时间', '计划', '触发方式', '结果', '大小', '耗时', '操作'].map((text) => h('th', { key: text, style: S.th }, text)),
            ),
          ),
          h(
            'tbody',
            null,
            runs.map((run) =>
              h(
                React.Fragment,
                { key: run.id },
                h(
                  'tr',
                  null,
                  h('td', { style: S.td }, fmtTime(run.finishedAt || run.startedAt)),
                  h('td', { style: S.td }, run.planName || '—'),
                  h('td', { style: S.td }, run.trigger === 'scheduled' ? '定时' : '手动'),
                  h(
                    'td',
                    { style: Object.assign({}, S.td, run.status === 'success' ? S.ok : S.err) },
                    run.status === 'running' ? '进行中' : run.status === 'success' ? '成功' : '失败',
                    run.error ? '：' + run.error : '',
                  ),
                  h('td', { style: S.td }, run.archive ? fmtBytes(run.archive.size || run.bytes) : fmtBytes(run.bytes)),
                  h('td', { style: S.td }, run.durationMs ? (run.durationMs / 1000).toFixed(1) + 's' : '—'),
                  h(
                    'td',
                    { style: Object.assign({}, S.td, { whiteSpace: 'nowrap' }) },
                    run.status === 'success'
                      ? h(
                          'span',
                          {
                            style: Object.assign({}, S.link, { marginRight: 10 }),
                            onClick: () => setRestoreRun(restoreRun === run.id ? '' : run.id),
                          },
                          '恢复',
                        )
                      : null,
                    h(
                      'span',
                      { style: S.link, onClick: () => setOpenLog(openLog === run.id ? '' : run.id) },
                      openLog === run.id ? '收起日志' : '日志',
                    ),
                  ),
                ),
                openLog === run.id
                  ? h(
                      'tr',
                      null,
                      h(
                        'td',
                        { colSpan: 7, style: { padding: '0 8px 8px' } },
                        h(
                          'pre',
                          { style: S.pre },
                          (run.log || []).map((line) => fmtTime(line.at) + '  ' + line.text).join('\n') || '（没有日志）',
                        ),
                      ),
                    )
                  : null,
                restoreRun === run.id
                  ? h(
                      'tr',
                      null,
                      h(
                        'td',
                        { colSpan: 7, style: { padding: '0 8px' } },
                        h(RestorePanel, { run, onClose: () => setRestoreRun('') }),
                      ),
                    )
                  : null,
              ),
            ),
            h(
              'tr',
              null,
              h(
                'td',
                { colSpan: 7, style: { padding: '10px 8px 2px' } },
                h(
                  'button',
                  {
                    style: S.btn,
                    onClick: async () => {
                      const res = await send('POST', '/history/clear', {})
                      notify(res && res.ok ? '历史已清空' : '清空失败', res && res.ok ? 'ok' : 'err')
                      props.reload()
                    },
                  },
                  '清空历史',
                ),
              ),
            ),
          ),
        ),
      )
    }

    function Section() {
      const [draft, setDraft] = useState(null)
      const [server, setServer] = useState(null)
      const [runs, setRuns] = useState([])
      const [running, setRunning] = useState(null)
      const [busyPlan, setBusyPlan] = useState('')
      const [notice, setNotice] = useState('')
      const [tone, setTone] = useState('info')
      const [openLog, setOpenLog] = useState('')
      const [offline, setOffline] = useState(null)
      const dirty = useRef(false)
      // 「放弃改动」要连计划卡片里的临时状态（比如间隔选了自定义）一起复位，
      // 靠换 key 强制重建卡片；否则 customMode 是 useState 初始值，重拉配置也不会变。
      const [resetTick, setResetTick] = useState(0)

      function notify(text, kind) {
        setNotice(text)
        setTone(kind || 'info')
      }

      async function load() {
        try {
          const data = await get('')
          if (!data || !data.ok) {
            notify('读取配置失败：' + ((data && data.error) || '宿主插件没有响应'), 'err')
            return
          }
          setServer(data)
          setRuns(data.state.runs || [])
          if (!dirty.current) setDraft(toDraft(data.config))
        } catch (err) {
          notify('读取配置失败：' + err.message, 'err')
        }
      }

      useEffect(() => {
        load()
        get('/restore/result')
          .then((res) => {
            if (res && res.ok && res.result) setOffline(res)
          })
          .catch(() => {})
        const timer = setInterval(() => {
          if (!dirty.current) load()
        }, 5000)
        return () => clearInterval(timer)
      }, [])

      useEffect(() => {
        if (!busyPlan) return undefined
        const timer = setInterval(async () => {
          const data = await get('/progress')
          setRunning(data && data.running ? data.running : null)
        }, 1200)
        return () => clearInterval(timer)
      }, [busyPlan])

      function update(next) {
        dirty.current = true
        setDraft(next)
      }

      function updatePlan(index, plan) {
        const plans = draft.plans.slice()
        plans[index] = plan
        update(Object.assign({}, draft, { plans }))
      }

      async function save(silent) {
        // 目标目录空着（或者根本不是完整路径）就直接拦住，不提交。
        // 否则后端 expandHome 会把它规整成一个路径，界面上看起来就像「填过了」。
        const bad = (draft.plans || []).filter((plan) => {
          const t = String(plan.target || '').trim()
          return !t || !/^(~|[a-zA-Z]:[\\/]|\\\\|\/)/.test(t)
        })
        if (bad.length) {
          const names = bad.map((plan) => plan.name || '未命名计划').join('、')
          notify('保存失败：' + names + ' 还没填目标目录（要完整路径，例如 D:\\Backup）', 'err')
          return false
        }
        const res = await send('PUT', '/config', { config: fromDraft(draft) })
        if (!res || !res.ok) {
          notify('保存失败：' + ((res && (res.error || (res.warnings && JSON.stringify(res.warnings)))) || '未知原因'), 'err')
          return false
        }
        dirty.current = false
        if (!silent) notify('配置已保存', 'ok')
        if (res.warnings && res.warnings.length) {
          notify('已保存，但有 ' + res.warnings.length + ' 个计划还不能运行：' + res.warnings.map((w) => w.plan).join('、'), 'err')
        }
        await load()
        return true
      }

      async function browse(kind) {
        try {
          const res = await send('POST', '/open', { kind })
          if (res && res.ok && res.path) return res.path
          if (res && res.ok && res.cancelled) return ''
          notify('这个环境打不开系统目录选择，请直接把路径粘到输入框里', 'err')
        } catch (err) {
          notify('打开目录选择失败：' + err.message, 'err')
        }
        return ''
      }

      async function runNow(plan) {
        if (dirty.current) {
          const ok = await save(true)
          if (!ok) return
        }
        setBusyPlan(plan.id || plan.name)
        setRunning({ planName: plan.name, log: [] })
        notify('正在备份：' + plan.name + '，完成后会显示结果', 'info')
        try {
          const res = await send('POST', '/run', { planId: plan.id })
          if (!res || !res.ok) {
            notify('备份失败：' + ((res && res.error) || '未知原因'), 'err')
          } else {
            // 备份在后台跑，这里只负责等它结束；中途关掉设置页不影响备份本身。
            for (let i = 0; i < 7200; i += 1) {
              await new Promise((resolve) => setTimeout(resolve, 1000))
              const prog = await get('/progress').catch(() => null)
              if (!prog || !prog.running) break
              setRunning(prog.running)
            }
            notify('备份已结束，结果见下方历史记录', 'ok')
          }
        } catch (err) {
          notify('备份请求失败：' + err.message, 'err')
        }
        setBusyPlan('')
        setRunning(null)
        await load()
      }

      if (!draft) return h('div', { style: S.wrap }, h('div', { style: S.hint }, '正在读取备份配置…'))

      const toneStyle = tone === 'err' ? S.err : tone === 'ok' ? S.ok : S.info

      return h(
        'div',
        { style: S.wrap },
        h('div', { style: S.title }, '备份'),
        h(
          'div',
          { style: S.sub },
          '定时把多个来源目录全量备份到一个目标目录，每次运行都完整打一份新包，超出保留份数的旧包自动清理；「立即备份一次」不受定时限制。ZIP 走 PowerShell 打包，单包有 2GB 上限，来源超过 2GB 请用 TAR.GZ。',
          h('br'),
          '间隔从上一次开始时间算起，所以备份再久也不会堆积；DSH 没开的时候不会跑，也不会补跑。',
        ),

        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', margin: '0 0 14px' } },
          h(Check, {
            checked: draft.enabled !== false,
            onChange: (v) => update(Object.assign({}, draft, { enabled: v })),
            text: '开启定时备份',
          }),
          h(
            'button',
            { style: S.btnMain, onClick: () => save(false) },
            '保存配置' + (dirty.current ? '（有改动）' : ''),
          ),
          h('button', { style: S.btn, onClick: () => { dirty.current = false; setResetTick((n) => n + 1); load() } }, '放弃改动'),
          h(
            'div',
            { style: toneStyle },
            notice || (server ? '共 ' + draft.plans.length + ' 个计划' : ''),
          ),
        ),

        // 暂存目录：备份时先把文件复制到这里再打包，占空间较大，允许换到大容量盘。
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '0 0 14px', fontSize: 12 } },
          h('div', { style: { width: 64, flexShrink: 0, opacity: 0.75 } }, '暂存目录'),
          h('input', {
            style: Object.assign({}, S.input, { flex: '1 1 320px', minWidth: 240 }),
            value: draft.stageRoot || '',
            placeholder: '默认 ~/.dsh/backup-stage',
            title: '备份时先把文件复制到这里再打包，占空间较大；备份大目录时建议换到大容量盘',
            onChange: (e) => update(Object.assign({}, draft, { stageRoot: e.target.value })),
          }),
          h(
            'button',
            {
              style: S.btn,
              onClick: async () => {
                const picked = await browse('source')
                if (picked) update(Object.assign({}, draft, { stageRoot: picked }))
              },
            },
            '浏览…',
          ),
          h('span', { style: S.hint }, '备份时临时存放在这里，每次备份结束后自动清空'),
        ),

        running
          ? h(
              'div',
              { style: { border: '1px solid rgba(90,140,255,.4)', borderRadius: 8, padding: '8px 12px', margin: '0 0 12px', fontSize: 12 } },
              h('div', { style: { fontWeight: 600, marginBottom: 4 } }, '正在备份：' + (running.planName || '')),
              h('div', { style: S.hint }, '已备份 ' + (running.copied || 0) + ' / ' + (running.files || 0) + ' 个文件（备份在后台执行，关掉这个页面不会中断）'),
              h(
                'button',
                {
                  style: S.btn,
                  onClick: async () => {
                    const r = await send('POST', '/stop', {})
                    notify((r && r.note) || '已请求停止', r && r.ok ? 'info' : 'err')
                  },
                },
                '停止',
              ),
              h('div', null, (running.log || []).slice(-3).map((line, i) => h('div', { key: i, style: S.hint }, line.text))),
            )
          : null,

        draft.plans.map((plan, index) =>
          h(PlanCard, {
            key: (plan.id || 'new-' + index) + ':' + resetTick,
            plan,
            index,
            onChange: (next) => updatePlan(index, next),
            onDelete: (i) => {
              const plans = draft.plans.filter((_, idx) => idx !== i)
              update(Object.assign({}, draft, { plans }))
            },
            onRun: runNow,
            onBrowse: browse,
            notify,
            running: !!busyPlan && (busyPlan === plan.id || busyPlan === plan.name),
          }),
        ),

        h(
          'div',
          { style: { display: 'flex', gap: 10, margin: '4px 0 18px' } },
          h(
            'button',
            {
              style: S.btnMain,
              onClick: () => {
                const plans = (draft.plans || []).concat([
                  {
                    id: '',
                    name: '备份计划 ' + (draft.plans.length + 1),
                    enabled: true,
                    intervalMinutes: 1440,
                    format: 'zip',
                    sources: [],
                    target: '',
                    exclude: '',
                    keep: 7,
                    verify: true,
                  },
                ])
                update(Object.assign({}, draft, { plans }))
              },
            },
            '新建备份计划',
          ),
        ),

        h('div', { style: { fontSize: 13, fontWeight: 600, margin: '8px 0 8px' } }, '备份历史'),
        offline
          ? h(
              'div',
              { style: S.hint },
              '上次离线恢复（' + fmtTime((offline.result && offline.result.finishedAt) || '') + '）：成功 ' +
                ((offline.result && offline.result.restored) || 0) + ' 个，跳过 ' +
                (((offline.result && offline.result.skipped) || []).length) + ' 个' +
                (((offline.result && offline.result.failed) || []).length
                  ? '，失败 ' + offline.result.failed.join('；')
                  : ''),
            )
          : null,
        h(History, { runs, openLog, setOpenLog, notify, reload: load }),

        h(
          'div',
          { style: Object.assign({}, S.hint, { marginTop: 16 }) },
          '路径以 ~ 开头表示当前用户目录；来源目录里如果包含目标目录会被拒绝，避免自己备份自己。',
        ),
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () =>
        slots.register(
          {
            name: 'settings.section',
            id: 'backup',
            order: 54,
            label: () => '备份',
          },
          () => React.createElement('div', null, React.createElement(Section)),
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
