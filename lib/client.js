/**
 * bili-duty —— Client 半（Web 设置页）
 * ============================================================================
 * 形态：静态客户端模块，按官方 templates/decoration 的 `window.__ModuleLoader__.load`
 * 约定注册一个惰性 factory，把设置页挂进 `settings.section` 槽位。
 * 与 Host 的通信：只走插件自己注册的 HTTP 路由（/bili-duty/*.json），
 * 不使用任何 Harness Client 包，也不 import @deepseek-ai/*（那是明文禁止的）。
 * 样式：只用主题 token（--dsw-alias-*），浅色/深色自动跟随。
 * ============================================================================
 */

window.__ModuleLoader__.load({
  id: 'bili-duty',
  factory(require) {
    // ⚠️ 兜底：factory 体里任何 throw 都会让这个 entry `failed`，
    // 而 web boot 把 entry failed 当**致命** —— 用户看到的就是"应用无法启动"。
    // 所以整个 factory 包一层：炸了就返回一个什么都不做的空插件，DSH 照常启动。
    try {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    // ── 基础样式（类名统一 bd- 前缀，颜色全部走 token）─────────────────
    const CSS = [
      '.bd-wrap{display:flex;flex-direction:column;gap:20px;padding:4px 2px 32px;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary);}',
      '.bd-top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;}',
      '.bd-title{font-size:15px;font-weight:600;margin:0;}',
      '.bd-sub{color:var(--dsw-alias-label-secondary);font-size:12px;margin:2px 0 0;}',
      '.bd-group{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;}',
      '.bd-group>h3{margin:0;padding:10px 14px;font-size:12px;font-weight:600;letter-spacing:.4px;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);}',
      '.bd-row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1);}',
      '.bd-row:first-of-type{border-top:0;}',
      '.bd-row-main{flex:1 1 auto;min-width:0;}',
      '.bd-row-label{font-size:13px;}',
      '.bd-row-hint{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:2px;}',
      '.bd-row-ctl{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding-top:2px;}',
      '.bd-wide{display:block;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1);}',
      '.bd-wide:first-of-type{border-top:0;}',
      '.bd-input,.bd-textarea,.bd-select{width:100%;box-sizing:border-box;padding:6px 10px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;outline:none;}',
      '.bd-input:focus,.bd-textarea:focus,.bd-select:focus{border-color:var(--dsw-alias-brand-primary);}',
      '.bd-textarea{min-height:116px;max-height:280px;resize:vertical;font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);line-height:1.5;}',
      '.bd-num{width:96px;}',
      '.bd-switch{position:relative;display:inline-flex;align-items:center;width:36px;height:20px;flex:0 0 auto;border-radius:999px;corner-shape:round;border:0;background:var(--dsw-alias-border-l2);cursor:pointer;padding:2px;transition:background .12s;}',
      '.bd-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary);}',
      '.bd-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}',
      '.bd-knob{display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-bg-base);box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .12s ease;}',
      '.bd-switch[aria-checked="true"] .bd-knob{transform:translateX(16px);}',
      '.bd-switch:disabled{opacity:.5;cursor:not-allowed;}',
      '.bd-chips{display:flex;flex-wrap:wrap;gap:6px;}',
      '.bd-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;font-size:12px;cursor:pointer;user-select:none;background:var(--dsw-alias-bg-base);}',
      '.bd-chip[data-on="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}',
      '.bd-chip input{margin:0;accent-color:var(--dsw-alias-brand-primary);}',
      '.bd-radio{display:flex;gap:16px;flex-wrap:wrap;}',
      '.bd-radio label{display:inline-flex;align-items:center;gap:6px;cursor:pointer;}',
      '.bd-radio input{accent-color:var(--dsw-alias-brand-primary);margin:0;}',
      '.bd-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:6px 14px;font:inherit;font-size:13px;border-radius:8px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}',
      '.bd-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2);filter:brightness(1.04);}',
      '.bd-btn:disabled{opacity:.5;cursor:not-allowed;}',
      '.bd-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground);font-weight:600;}',
      '.bd-btn-sm{padding:4px 10px;font-size:12px;}',
      '.bd-note{padding:8px 12px;border-radius:8px;font-size:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);}',
      '.bd-note[data-kind="ok"]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);}',
      '.bd-note[data-kind="warn"]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);}',
      '.bd-note[data-kind="err"]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);}',
      '.bd-banner{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);}',
      '.bd-banner[data-armed="true"]{border-color:var(--dsw-alias-state-success-primary);}',
      '.bd-banner[data-armed="false"]{border-color:var(--dsw-alias-state-idle-primary);}',
      '.bd-pill{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid currentColor;}',
      '.bd-mono{font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:12px;}',
      '.bd-table{width:100%;border-collapse:collapse;font-size:12px;}',
      '.bd-table th{text-align:left;font-weight:600;color:var(--dsw-alias-label-secondary);padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l2);white-space:nowrap;}',
      '.bd-table td{padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top;}',
      '.bd-table tr:last-child td{border-bottom:0;}',
      '.bd-table-wrap{max-height:320px;overflow:auto;}',
      '.bd-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}',
      '.bd-spacer{flex:1 1 auto;}',
      '.bd-kv{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;font-size:12px;}',
      '.bd-kv dt{color:var(--dsw-alias-label-secondary);}',
      '.bd-kv dd{margin:0;word-break:break-all;}',
      '.bd-inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}',
      '@media (max-width:720px){.bd-row{flex-direction:column;gap:8px;}}',
    ].join('\n')

    // ── Host 通信 ─────────────────────────────────────────────────────
    async function getJson(url) {
      const res = await fetch(url, { cache: 'no-store' })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`)
      return data
    }

    async function postJson(url) {
      const res = await fetch(url, { method: 'POST' })
      const data = await res.json().catch(() => null)
      return { ok: res.ok && data && data.ok !== false, data }
    }

    async function postConfig(config) {
      const res = await fetch('/bili-duty/config.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data || data.ok === false) throw new Error((data && data.error) || `HTTP ${res.status}`)
      return data
    }

    // ── 小组件 ────────────────────────────────────────────────────────
    function Switch({ checked, onChange, disabled, label }) {
      return h('button', {
        type: 'button',
        className: 'bd-switch',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': label,
        disabled: Boolean(disabled),
        onClick: () => onChange(!checked),
      }, h('span', { className: 'bd-knob' }))
    }

    function Row({ label, hint, children }) {
      return h('div', { className: 'bd-row' }, [
        h('div', { className: 'bd-row-main', key: 'm' }, [
          h('div', { className: 'bd-row-label', key: 'l' }, label),
          hint ? h('div', { className: 'bd-row-hint', key: 'h' }, hint) : null,
        ]),
        h('div', { className: 'bd-row-ctl', key: 'c' }, children),
      ])
    }

    function Wide({ label, hint, children }) {
      return h('div', { className: 'bd-wide' }, [
        h('div', { className: 'bd-row-label', key: 'l' }, label),
        hint ? h('div', { className: 'bd-row-hint', key: 'h' }, hint) : null,
        h('div', { style: { marginTop: 6 }, key: 'c' }, children),
      ])
    }

    function Group({ title, children }) {
      return h('section', { className: 'bd-group' }, [h('h3', { key: 't' }, title), children])
    }

    function Note({ kind, children }) {
      return h('div', { className: 'bd-note', 'data-kind': kind || 'info' }, children)
    }

    function NumberInput({ value, min, max, onChange, width }) {
      // 宿主没有 <input type="number">；官方形态是 text + inputMode="numeric"，
      // 不在输入过程中擅自改写用户敲下的内容 —— 越界值交给 Host 的 normalizeConfig 夹取。
      return h('input', {
        className: 'bd-input bd-num',
        type: 'text',
        inputMode: 'numeric',
        autoComplete: 'off',
        'aria-valuemin': min,
        'aria-valuemax': max,
        value: String(value ?? ''),
        style: width ? { width } : undefined,
        onChange: (e) => onChange(e.target.value.replace(/[^\d]/gu, '')),
      })
    }

    /** 单选组：options 是 [value, label] 对的数组。 */
    function radioGroup(name, options, current, onPick) {
      return h('div', { className: 'bd-radio' }, options.map(([value, label]) => h('label', { key: value }, [
        h('input', {
          key: 'i',
          type: 'radio',
          name,
          value,
          checked: current === value,
          onChange: () => onPick(value),
        }),
        label,
      ])))
    }

    function TextInput({ value, onChange, placeholder }) {
      return h('input', {
        className: 'bd-input',
        type: 'text',
        value: value ?? '',
        placeholder: placeholder || '',
        onChange: (e) => onChange(e.target.value),
      })
    }

    /** 相对时间；秒级与毫秒级时间戳都兼容。 */
    function relTime(ts) {
      const raw = Number(ts)
      if (!Number.isFinite(raw) || raw <= 0) return ''
      const ms = raw < 1e12 ? raw * 1000 : raw
      const diff = Date.now() - ms
      if (diff < 0) return ''
      if (diff < 60000) return '刚刚'
      if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
      if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
      return `${Math.floor(diff / 86400000)} 天前`
    }

    /**
     * 会话在下拉里的显示文本。
     * ⚠️ 这里踩过坑：会话 id 形如 `session-xxxxxxxx-....`，截**前** 8 位永远是 `session-`，
     * 配上取不到的标题，整列会话会全都长成「（未命名会话）— session-…」——
     * 用户根本没法确认自己选的是哪一个（实测被用户当场发现）。
     * 所以：标题取不到就用「无标题会话」，用 id 的**后 8 位**做辨识，并标出此刻是否活着。
     * 标题与工作区都是**运行时读**的（sessionQuery / 投影缓存），
     * 所以新建会话、重命名之后这里会自动跟上，不需要改任何代码。
     */
    function sessionLabel(s) {
      const mark = s.live ? '●' : '○'
      const title = s.title || '（无标题会话）'
      const when = relTime(s.updatedAt)
      const ws = workspaceTail(s.cwd)
      const tail = `…${String(s.id).slice(-8)}`
      const state = s.live ? '运行中' : '未打开'
      return `${mark} ${title}${when ? ` · ${when}` : ''}${ws ? ` · ${ws}` : ''} · ${tail} · ${state}`
    }

    /** 路径末段（工作区名），帮人认出这是哪个会话。 */
    function workspaceTail(cwd) {
      const text = String(cwd || '').trim()
      if (!text) return ''
      const parts = text.split(/[\\/]/u).filter(Boolean)
      return parts.length > 0 ? parts[parts.length - 1] : ''
    }

    /** 客户端半的自检回执（Host 从页面心跳里记下来的）。 */
    function clientDiagNote(diag) {
      if (!diag) {
        return h(Note, { kind: 'warn' },
          '页面上的客户端半还没回报过心跳。常见原因：这台机器上还没刷新过页面，或者注入的自检脚本没跑起来。' +
          '刷新一次页面（F5）后这里会变成「已加载」或带上具体报错。')
      }
      const ok = diag.phase === 'applied' || diag.phase === 'script-loaded' || diag.phase === 'loaded'
      return h('div', null, [
        h(Note, { key: 'n', kind: ok ? 'ok' : 'err' },
          `${ok ? '已加载' : '有报错'}｜阶段 ${diag.phase}｜${diag.detail || '无细节'}`),
        h('div', { className: 'bd-row-hint', key: 'd', style: { marginTop: 4 } },
          `回执时间 ${diag.at}${diag.href ? `｜页面 ${diag.href}` : ''}`),
      ])
    }

    // ── 设置页主体 ────────────────────────────────────────────────────
    /**
     * ⚠️ 安全审查 C7：只渲染我们约定的 SVG data URL 前缀。
     * Host 侧生成的是 `data:image/svg+xml;base64,`（在 `<img>` 上下文里 SVG 不执行脚本），
     * 但渲染方式一旦被改动（改成 iframe / innerHTML 之类），没有前缀校验就会变成注入点。
     * （定义在组件外层：设置页渲染与 apply 里的心跳都能用。）
     */
    const isSafeQrDataUrl = (value) => typeof value === 'string'
      && value.startsWith('data:image/svg+xml;base64,')

    function BiliDutyPanel() {
      const [config, setConfig] = useState(null)
      const [state, setState] = useState(null)
      const [sessions, setSessions] = useState([])
      const [sessionsMeta, setSessionsMeta] = useState('')
      const [history, setHistory] = useState(null)
      const [message, setMessage] = useState(null)
      const [busy, setBusy] = useState(false)
      const [dirty, setDirty] = useState(false)
      const [account, setAccount] = useState(null)
      const [login, setLogin] = useState(null)
      const mounted = useRef(true)

      // ⚠️ 安全审查 C6：原实现只在 cleanup 里置 false，遇到 React 18 的 StrictMode
      // （mount→unmount→mount）就会永久停在「正在读取…」。改成每次挂载都重置为 true。
      useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false }
      }, [])

      const load = useCallback(async () => {
        try {
          const [cfg, st] = await Promise.all([
            getJson('/bili-duty/config.json'),
            getJson('/bili-duty/state.json'),
          ])
          if (!mounted.current) return
          setConfig(cfg.config)
          setState(st)
          setDirty(false)
          try {
            const s = await getJson('/bili-duty/sessions.json')
            if (mounted.current) {
              const list = s.sessions || []
              setSessions(list)
              const liveCount = list.filter((x) => x.live).length
              setSessionsMeta(s.fallback
                ? `⚠️ 没拿到完整会话列表，这里只列出「当前活着的」会话${s.listError ? `（${s.listError}）` : ''}`
                : `共 ${list.length} 个会话，其中 ${liveCount} 个正在运行（● 能立刻唤醒；○ 需要先在 DSH 里打开）`)
            }
          } catch (err) {
            if (mounted.current) setSessionsMeta(`读会话列表失败：${String(err.message || err)}`)
          }
          try {
            const hist = await getJson('/bili-duty/history.json?limit=20')
            if (mounted.current) setHistory(hist)
          } catch (err) { /* 历史可选 */ }
          try {
            const who = await getJson('/bili-duty/whoami')
            if (mounted.current) setAccount(who)
          } catch (err) { /* 账号状态可选 */ }
        } catch (err) {
          if (mounted.current) setMessage({ kind: 'err', text: `读设置失败：${String(err.message || err)}` })
        }
      }, [])

      useEffect(() => { void load() }, [load])

      // ── 扫码登录 ──────────────────────────────────────────────────────
      const startLogin = useCallback(async () => {
        setBusy(true)
        try {
          const response = await fetch('/bili-duty/login/start', { method: 'POST' })
          const data = await response.json()
          if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`)
          if (mounted.current) {
            setLogin({ svgDataUrl: data.svgDataUrl, status: 'waiting', message: data.hint || '' })
            setMessage(null)
          }
        } catch (err) {
          if (mounted.current) setMessage({ kind: 'err', text: `申请二维码失败：${String(err.message || err)}` })
        } finally {
          if (mounted.current) setBusy(false)
        }
      }, [])

      // 拿到码之后每 2 秒问一次结果（只在自己这边轮询，不打扰用户）
      const loginStatus = login && login.status
      useEffect(() => {
        if (loginStatus !== 'waiting' && loginStatus !== 'scanned') return undefined
        // ⚠️ 安全审查 C4：原本无限轮询（2 秒一次、异常被完全吞掉）。
        // 现在封顶 3 分钟，到点按「过期」处理，让用户重新点一次，而不是静默一直转。
        const startedAt = Date.now()
        const MAX_POLL_MS = 3 * 60 * 1000
        let failures = 0
        const timer = setInterval(async () => {
          if (Date.now() - startedAt > MAX_POLL_MS) {
            clearInterval(timer)
            if (mounted.current) {
              setLogin((prev) => (prev
                ? { ...prev, status: 'expired', message: '二维码超时（3 分钟），请重新点「扫码登录」' }
                : prev))
            }
            return
          }
          try {
            const response = await fetch('/bili-duty/login/poll', { method: 'POST' })
            const data = await response.json()
            if (!mounted.current) return
            failures = 0
            if (data.status === 'waiting' || data.status === undefined) return
            if (data.status === 'scanned') {
              setLogin((prev) => (prev ? { ...prev, status: 'scanned' } : prev))
              return
            }
            if (data.status === 'success') {
              const name = data.account && data.account.uname ? data.account.uname : ''
              setLogin((prev) => (prev ? { ...prev, status: 'success' } : prev))
              setAccount({ ok: true, loggedIn: true, account: data.account, credential: data.credential })
              setMessage({ kind: 'ok', text: `登录成功${name ? `：${name}` : ''}，凭证已存在插件家目录` })
              return
            }
            if (data.status === 'expired') {
              setLogin((prev) => (prev ? { ...prev, status: 'expired' } : prev))
            }
          } catch (err) {
            // 单次失败无所谓；连续失败要让用户看见原因，而不是永远转圈（C4）
            failures += 1
            if (failures >= 3 && mounted.current) {
              setLogin((prev) => (prev
                ? { ...prev, message: `查询登录结果失败：${String(err.message || err)}` }
                : prev))
            }
          }
        }, 2000)
        return () => clearInterval(timer)
      }, [loginStatus])

      const patch = useCallback((updater) => {
        setConfig((prev) => {
          const next = typeof updater === 'function' ? updater(prev) : { ...prev, ...updater }
          return next
        })
        setDirty(true)
        setMessage(null)
      }, [])

      const save = useCallback(async () => {
        if (!config) return
        setBusy(true)
        try {
          const res = await postConfig(config)
          if (mounted.current) {
            setConfig(res.config)
            setDirty(false)
            setMessage({ kind: 'ok', text: '已保存，设置立即生效（定时器按新配置跑）' })
          }
          await load()
        } catch (err) {
          if (mounted.current) setMessage({ kind: 'err', text: `保存失败：${String(err.message || err)}` })
        } finally {
          if (mounted.current) setBusy(false)
        }
      }, [config, load])

      const runNow = useCallback(async () => {
        setBusy(true)
        try {
          const res = await postJson('/bili-duty/run-now')
          const text = (res.data && res.data.message) || (res.ok ? '已投递' : '投递失败')
          setMessage({ kind: res.ok ? 'ok' : 'warn', text })
          await load()
        } catch (err) {
          setMessage({ kind: 'err', text: `触发失败：${String(err.message || err)}` })
        } finally {
          if (mounted.current) setBusy(false)
        }
      }, [load])

      if (!config) {
        return h('div', { className: 'bd-wrap' }, [
          h('style', { key: 'bd-css' }, CSS),
          h('div', { className: 'bd-note', key: 'n' }, message ? message.text : '正在读取 bili-duty 设置…'),
        ])
      }

      const set = (key) => (value) => patch({ [key]: value })
      const weekdays = [
        [1, '周一'], [2, '周二'], [3, '周三'], [4, '周四'], [5, '周五'], [6, '周六'], [7, '周日'],
      ]

      const info = state || {}
      const paths = info.paths || {}
      const live = info.sessionLive

      // ⚠️ 安全审查 C5：整棵元素树是在这里**同步构建**的（Host 返回的 config / state / history
      // 都在这一刻被解引用）。用 try/catch 兜住构建期异常 —— 版本不一致或缺字段时显示可读提示，
      // 而不是让设置页白屏。
      try {
        return h('div', { className: 'bd-wrap' }, [
        // 样式随组件渲染：React 元素在卸载时自动移除，不需要（也无法）去碰 ctx.styles。
        h('style', { key: 'bd-css' }, CSS),
        h('div', { className: 'bd-top', key: 'top' }, [
          h('div', { key: 'l' }, [
            h('h2', { className: 'bd-title', key: 't' }, '刷B站值班表'),
            h('p', { className: 'bd-sub', key: 's' },
              '插件负责定时、配置与记录；"值不值得看"的判断留在被唤醒的会话里，由那个会话里的 AI 做。'),
          ]),
          h('div', { className: 'bd-actions', key: 'r' }, [
            dirty ? h('span', { className: 'bd-pill', key: 'd', style: { color: 'var(--dsw-alias-state-warn-primary)' } }, '有未保存改动') : null,
            h('button', {
              className: 'bd-btn bd-btn-primary', key: 'save', type: 'button',
              disabled: busy || !dirty, onClick: () => void save(),
            }, busy ? '处理中…' : '保存'),
            h('button', {
              className: 'bd-btn', key: 'run', type: 'button',
              disabled: busy || !config.enabled, onClick: () => void runNow(),
            }, '立即跑一轮'),
          ]),
        ]),

        message ? h(Note, { key: 'msg', kind: message.kind }, message.text) : null,

        h('div', { className: 'bd-banner', key: 'banner', 'data-armed': config.enabled ? 'true' : 'false' }, [
          h('div', { key: 'l' }, [
            h('div', { key: 'a' }, config.enabled ? '总开关：开着' : '总开关：关着（一切停跑，含定时与手动触发）'),
            h('div', { className: 'bd-row-hint', key: 'b' },
              config.target_session_id
                ? `目标会话：${config.target_session_id}${live ? '（正在运行）' : '（当前不在运行 —— 打开它才会真的被唤醒）'}`
                : '还没选目标会话：被唤醒的必须是 DSH 里真实打开的会话'),
          ]),
          h(Switch, {
            key: 'sw', label: '总开关', checked: config.enabled,
            onChange: (v) => patch({ enabled: v }),
          }),
        ]),

        // ── 采集 ────────────────────────────────────────────────────
        h(Group, { key: 'g1', title: '采集' }, [
          h(Wide, { key: 'kw', label: '关注关键词', hint: '一行一个；留空则用内置 5 组' }, h('textarea', {
            className: 'bd-textarea',
            value: (config.keywords || []).join('\n'),
            onChange: (e) => patch({ keywords: e.target.value.split(/\r?\n/u) }),
            spellCheck: false,
          })),
          h(Row, { key: 'lb', label: '只扫最近几天', hint: 'lookback_days' },
            h(NumberInput, { value: config.lookback_days, min: 1, max: 365, onChange: set('lookback_days') })),
          h(Row, { key: 'mi', label: '每轮最多推荐几条', hint: 'max_items_per_run' },
            h(NumberInput, { value: config.max_items_per_run, min: 1, max: 50, onChange: set('max_items_per_run') })),
          h(Row, { key: 'mc', label: '每轮最多读几个视频的评论', hint: 'max_comment_reads —— 成本红线' },
            h(NumberInput, { value: config.max_comment_reads, min: 0, max: 100, onChange: set('max_comment_reads') })),
        ]),

        // ── 读取通道 ────────────────────────────────────────────────
        h(Group, { key: 'g2', title: '读取通道' }, [
          h(Row, { key: 'sub', label: '读字幕', hint: '登录后确实可读（实测 6 条语言轨、正文 397 行）；没登录时读不到' },
            h(Switch, { label: '读字幕', checked: config.read_subtitles, onChange: set('read_subtitles') })),
          h(Row, { key: 'cm', label: '读评论', hint: '评论通道已验证可用，且信息密度最高' },
            h(Switch, { label: '读评论', checked: config.read_comments, onChange: set('read_comments') })),
          h(Row, { key: 'dm', label: '读弹幕', hint: '弹幕是 protobuf，文本通道读不了' },
            h(Switch, { label: '读弹幕', checked: config.read_danmaku, onChange: set('read_danmaku') })),
        ]),

        // ── 自动评论 ────────────────────────────────────────────────
        h(Group, { key: 'g3', title: '自动评论（默认关闭 · 那是他的账号在说话）' }, [
          h(Row, { key: 'ac', label: '自动评论', hint: '关着的时候只写报告，一个字都不发' },
            h(Switch, { label: '自动评论', checked: config.auto_comment, onChange: set('auto_comment') })),
          config.auto_comment ? h(Row, { key: 'cn', label: '每轮最多发几条', hint: 'comment_max_per_run —— 默认 1（一条），调高才会更多' },
            h(NumberInput, { value: config.comment_max_per_run, min: 0, max: 5, onChange: set('comment_max_per_run') })) : null,
          config.auto_comment ? h(Wide, { key: 'at', label: '@ 谁（B站昵称）', hint: '留空 = 不发评论' },
            h(TextInput, { value: config.comment_at, onChange: set('comment_at'), placeholder: '例如：某个昵称' })) : null,
          config.auto_comment ? h(Row, { key: 'vd', label: '发送后延迟几分钟复核', hint: 'B站评论计数有 5–10 分钟延迟，禁止发完立即查' },
            h(NumberInput, { value: config.verify_delay_minutes, min: 1, max: 240, onChange: set('verify_delay_minutes') })) : null,
          config.auto_comment
            ? h(Wide, { key: 'warn' }, h(Note, { kind: 'warn' },
              '发送链路要求插件自持扫码登录凭证（浏览器登录态是 v20 加密，读不出来）。凭证未就位前，插件会如实返回 NOT_IMPLEMENTED，不会假装发成功。'))
            : null,
        ]),

        // ── 触发 ────────────────────────────────────────────────────
        h(Group, { key: 'g4', title: '触发' }, [
          h(Row, { key: 'mode', label: '计划', hint: 'manual 只有手动；daily/weekly 到点自动唤醒' },
            radioGroup('bd-mode', [['manual', '手动'], ['daily', '每天'], ['weekly', '每周']], config.schedule.mode,
              (m) => patch({ schedule: { ...config.schedule, mode: m } }))),
          config.schedule.mode !== 'manual'
            ? h(Row, { key: 'at', label: '每天几点跑', hint: 'schedule.at（本机时区）' },
              h('input', {
                className: 'bd-input', type: 'time', style: { width: 120 },
                value: config.schedule.at,
                onChange: (e) => patch({ schedule: { ...config.schedule, at: e.target.value || '12:30' } }),
              }))
            : null,
          config.schedule.mode === 'weekly'
            ? h(Wide, { key: 'wd', label: '星期几' }, h('div', { className: 'bd-chips' },
              weekdays.map(([n, name]) => h('label', {
                key: n, className: 'bd-chip',
                'data-on': (config.schedule.weekdays || []).includes(n) ? 'true' : 'false',
              }, [
                h('input', {
                  type: 'checkbox', key: 'i',
                  checked: (config.schedule.weekdays || []).includes(n),
                  onChange: (e) => {
                    const cur = new Set(config.schedule.weekdays || [])
                    if (e.target.checked) cur.add(n); else cur.delete(n)
                    patch({ schedule: { ...config.schedule, weekdays: [...cur].sort((a, b) => a - b) } })
                  },
                }),
                name,
              ]))))
            : null,
          h(Row, { key: 'op', label: '只在谷时跑', hint: `工作日峰时（${(config.peak_windows || []).join('、')}）不跑，周末全天跑` },
            h(Switch, { label: '只在谷时跑', checked: config.off_peak_only, onChange: set('off_peak_only') })),
          h(Row, { key: 'rd', label: '报告详略', hint: 'full 完整 / thin 薄版省 token / off 不写' },
            radioGroup('bd-detail', [['full', '完整'], ['thin', '薄版'], ['off', '不写']], config.report_detail,
              (v) => patch({ report_detail: v }))),
        ]),

        // ── 会话与路径 ──────────────────────────────────────────────
        h(Group, { key: 'g5', title: '目标会话与工作区' }, [
          h(Wide, {
            key: 'ts',
            label: '被唤醒的会话',
            hint: '● 运行中 = 现在就能被唤醒；○ 未打开 = 需要先在 DSH 里把它打开一次。选完记得点右上角「保存」。',
          },
            h('div', { className: 'bd-inline' }, [
              h('select', {
                className: 'bd-select', key: 'sel', style: { maxWidth: 460 },
                value: config.target_session_id || '',
                onChange: (e) => patch({ target_session_id: e.target.value }),
              }, [
                h('option', { key: '', value: '' }, '（未选择）'),
                ...sessions.map((s) => h('option', { key: s.id, value: s.id }, sessionLabel(s))),
                (config.target_session_id && !sessions.some((s) => s.id === config.target_session_id))
                  ? h('option', { key: 'cur', value: config.target_session_id },
                    `○ （已记录的会话，当前没打开）…${String(config.target_session_id).slice(-8)}`)
                  : null,
              ]),
              h('button', { className: 'bd-btn bd-btn-sm', key: 'r', type: 'button', onClick: () => void load() }, '刷新列表'),
            ]),
            sessionsMeta ? h('div', { className: 'bd-row-hint', style: { marginTop: 6 } }, sessionsMeta) : null),
          h(Wide, { key: 'ws', label: '工作区目录（存放 runs.md / seen.md / out/）', hint: '留空则用插件自有目录；填了就用这个目录里的那三个文件' },
            h(TextInput, { value: config.workspace, onChange: set('workspace'), placeholder: '例如 C:\\Users\\AA\\Documents\\deepseek-harness\\default-workspace\\bili-duty' })),
          h(Wide, { key: 'paths' }, h('dl', { className: 'bd-kv' }, [
            h('dt', { key: 'p1' }, '判重表'), h('dd', { className: 'bd-mono', key: 'v1' }, paths.seen || '—'),
            h('dt', { key: 'p2' }, '执行记录'), h('dd', { className: 'bd-mono', key: 'v2' }, paths.runs || '—'),
            h('dt', { key: 'p3' }, '判断准则'), h('dd', { className: 'bd-mono', key: 'v3' }, paths.prompt || '—'),
            h('dt', { key: 'p4' }, '报告目录'), h('dd', { className: 'bd-mono', key: 'v4' }, paths.out || '—'),
            h('dt', { key: 'p5' }, '插件家目录'), h('dd', { className: 'bd-mono', key: 'v5' }, info.pluginHome || '—'),
            h('dt', { key: 'p6' }, '本次会话时间'), h('dd', { className: 'bd-mono', key: 'v6' }, info.now || '—'),
          ])),
        ]),

        // ── 账号与登录（扫码；凭证只落本机）─────────────────────────
        h(Group, { key: 'g8', title: '账号与登录（凭证只存本机，不上传）' }, [
          h('div', { className: 'bd-wide', key: 'acct' }, [
            h('div', { className: 'bd-inline', key: 'row' }, [
              account && account.loggedIn
                ? h('span', {
                  className: 'bd-pill', key: 'st',
                  style: { color: 'var(--dsw-alias-state-success-primary)' },
                }, `已登录${account.account && account.account.uname ? `：${account.account.uname}` : ''}`)
                : h('span', {
                  className: 'bd-pill', key: 'st',
                  style: { color: 'var(--dsw-alias-state-warn-primary)' },
                }, account && account.credential && account.credential.present ? '有凭证但校验没过' : '未登录'),
              h('button', {
                className: 'bd-btn bd-btn-primary bd-btn-sm', key: 'go', type: 'button',
                disabled: busy, onClick: () => void startLogin(),
              }, login && login.status === 'expired' ? '重新扫码' : '扫码登录'),
              h('button', {
                className: 'bd-btn bd-btn-sm', key: 're', type: 'button',
                onClick: () => void load(),
              }, '检查身份'),
            ]),
            login && isSafeQrDataUrl(login.svgDataUrl)
              ? h('div', { key: 'qrbox', style: { marginTop: 10 } }, [
                h('img', {
                  key: 'qr', src: login.svgDataUrl, width: 220, height: 220,
                  alt: 'B站 登录二维码',
                  style: { display: 'block', background: '#fff', padding: 8, borderRadius: 10, border: '1px solid var(--dsw-alias-border-l1)' },
                }),
                h('div', { className: 'bd-row-hint', key: 'hint', style: { marginTop: 6 } },
                  login.message || '用手机 B站 App 扫这张码'),
                login.status === 'scanned'
                  ? h(Note, { key: 's', kind: 'ok' }, '已扫码 —— 请在手机上点确认（选「记住我 / 长期」）')
                  : null,
                login.status === 'success'
                  ? h(Note, { key: 'ok', kind: 'ok' }, '登录成功，凭证已写进插件家目录')
                  : null,
                login.status === 'expired'
                  ? h(Note, { key: 'ex', kind: 'warn' }, '二维码过期了，点「重新扫码」再来一次')
                  : null,
              ])
              : null,
            h('div', { className: 'bd-row-hint', key: 'note', style: { marginTop: 8 } },
              '凭证写在插件的 bili_credential.json 里（本机），页面上不会回显。'
              + '登录后才谈得上「发评论」与「读需要登录的内容（官方 AI 字幕等）」。'),
          ]),
        ]),

        // ── 执行历史 ────────────────────────────────────────────────
        h(Group, { key: 'g6', title: '执行历史（runs）' }, [
          h('div', { className: 'bd-wide', key: 'h' },
            !history || !history.readable
              ? h(Note, { kind: 'warn' }, `读不到执行记录：${(history && history.error) || '文件不存在'}`)
              : (history.rows.length === 0
                ? h(Note, null, '还没有记录。跑一轮后会在这里出现。')
                : h('div', { className: 'bd-table-wrap' }, h('table', { className: 'bd-table' }, [
                  h('thead', { key: 'h' }, h('tr', null,
                    ['时间', '触发', '结果', '扫描', '收取', '跳过', '无字幕', '评论', '备注'].map((c) => h('th', { key: c }, c)))),
                  h('tbody', { key: 'b' }, history.rows.map((r, i) => h('tr', { key: i }, [
                    h('td', { key: 't' }, r.time),
                    h('td', { key: 'g' }, r.trigger),
                    h('td', { key: 'r' }, r.result),
                    h('td', { key: 's' }, String(r.scanned)),
                    h('td', { key: 'k' }, String(r.kept)),
                    h('td', { key: 'x' }, String(r.skipped)),
                    h('td', { key: 'n' }, String(r.noSubtitle)),
                    h('td', { key: 'c' }, String(r.comments)),
                    h('td', { key: 'm' }, r.note),
                  ]))),
                ])))),
        ]),

        h('div', { className: 'bd-note', key: 'foot' },
          '纪律：判断留在会话里；默认不发评论；判重表读不出来时不许当成"没记录过"；报告末尾固定写「因无字幕跳过 N 条」，N=0 也写。'),

        // ── 自检（排障用；正常情况下这里显示"已加载 / 正在运行"）──────────
        h(Group, { key: 'g7', title: '自检' }, [
          h('div', { className: 'bd-wide', key: 'cd' }, clientDiagNote(info.clientDiag)),
          h(Wide, { key: 'cm', label: '宿主侧实测', hint: '读的是本插件自己注册的 /bili-duty/*.json 路由' },
            h('div', { className: 'bd-inline' }, [
              h('span', { className: 'bd-pill', key: 'a', style: { color: 'var(--dsw-alias-state-success-primary)' } }, 'Host 半：运行中'),
              h('span', { className: 'bd-pill', key: 'b' }, `定时器：每 60 秒一跳`),
              h('span', { className: 'bd-pill', key: 'c' }, `计划状态：${(info.schedule && info.schedule.lastFiredDate) || '今天还没跑过'}`),
            ])),
        ]),
      ])
      } catch (err) {
        // C5 兜底：元素树构建失败也不能白屏，至少把原因显示出来
        return h('div', { className: 'bd-wrap' }, [
          h('style', { key: 'bd-css-err' }, CSS),
          h('div', { className: 'bd-note', key: 'err' },
            `bili-duty 设置页渲染失败（多半是 Host 与客户端版本不一致）：${String(err?.message || err)}`),
        ])
      }
    }

    return {
      // ⚠️ 只声明真正的 Cordis 客户端服务。
      // `styles` / `React` / `host` / `console` 是 factory 形参里的**模块内置对象**，不是服务 ——
      // 把 `styles` 写进 inject，本插件就会永久 pending（等一个永不存在的服务），
      // 而待激活的服务会把整个 web boot 卡死（0.1.0 实测：`web boot: 1 entry did not activate`
      // / `bili-duty: pending (waiting for service: styles)`）。
      inject: ['slots'],
      apply(ctx) {
        // 注意：这里任何 throw 都会导致整个 web boot failed、DSH 起不来。
        // 全部 try/catch，错误通过心跳上报，绝不向外抛。

        /**
         * ⚠️ 安全审查 C2：上报页面地址时**只留 origin + pathname**，剔除 query / hash。
         * DSH 的 URL 一旦带上会话 id 或一次性参数，完整 href 上报就等于把它们写进插件内存态、
         * 并在设置页回显（截图或转发排障即间接外泄）。排障只需要知道"在哪个页面"。
         */
        const safeHref = () => {
          try {
            return `${location.origin}${location.pathname}`
          } catch (err) {
            return '(取不到 location)'
          }
        }

        const reportErr = (phase, detail) => {
          try {
            fetch('/bili-duty/hello', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                phase, detail: String(detail).slice(0, 500),
                href: safeHref(), loader: typeof window.__ModuleLoader__,
                ua: navigator.userAgent,
              }),
            }).catch(() => {})
          } catch (e) {}
        }
        // 样式不在这里注册：`ctx.styles` 并不存在。
        // `styles` / `React` / `host` / `console` 是这个 factory 的**形参**（模块内置对象），
        // 不是 ctx 上的服务 —— 写 `ctx.styles.insert()` 只会抛 TypeError 并把 web boot 放倒。
        // CSS 改为随组件渲染 `<style>`，卸载自动清除（官方 ui-plugin 文档认可的做法）。
        try {
          if (ctx.slots && typeof ctx.slots.inject === 'function') {
            ctx.slots.inject('settings.section', () => ctx.slots.register({
              name: 'settings.section',
              id: 'bili-duty',
              order: 60,
              label: '刷B站值班表',
            }, BiliDutyPanel))
          } else {
            reportErr('no-slots', 'ctx.slots.inject 不存在')
          }
        } catch (err) {
          reportErr('slots-threw', err?.stack || err?.message || err)
        }

        // ── 自检心跳 ────────────────────────────────────────────────────
        // 目的：让 Host 侧（以及设置页本身）**不用连浏览器桥**就能确认
        // "客户端半到底有没有加载"。注入的 boot 脚本和本文件同源同级，
        // 所以心跳成功 = 这个客户端模块真的进页面了；失败原因也一并回传。
        try {
          const state = { phase: 'start', detail: '', loader: typeof window.__ModuleLoader__, ua: navigator.userAgent }
          const report = (phase, detail) => {
            state.phase = phase
            state.detail = String(detail || '').slice(0, 400)
            try { state.href = safeHref() }
            catch (err) { /* 忽略 */ }
            try {
              void fetch('/bili-duty/hello', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(state),
                cache: 'no-store',
              }).catch(() => {})
            } catch (err) { /* 忽略 */ }
          }
          report('loaded')
          window.addEventListener('error', (event) => report('window-error', event.message))
          if (typeof window.__ModuleLoader__ === 'undefined') report('no-module-loader', 'window.__ModuleLoader__ 缺失')
          else report('applied', `slots/style 已注册｜href=${String(safeHref()).slice(0, 200)}`)
        } catch (err) {
          /* 自检本身绝不能影响插件 */
        }
      },
    }
    } catch (err) {
      // 兜底路径：不能抛，只能静默降级（错误尽量回传给 Host 的诊断路由）。
      try {
        fetch('/bili-duty/hello', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phase: 'factory-threw',
            detail: String((err && (err.stack || err.message)) || err).slice(0, 500),
            href: safeHref(),
            loader: typeof window.__ModuleLoader__,
            ua: navigator.userAgent,
          }),
        }).catch(() => {})
      } catch (ignored) { /* 连上报都失败时保持沉默 */ }
      return { apply() {} }
    }
  },
})
