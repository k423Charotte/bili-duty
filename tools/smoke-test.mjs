/**
 * bili-duty Host 半的离线冒烟测试（不连 DSH、不碰真实 $DSH_HOME）。
 *
 * 覆盖：默认值合并、runs 追加与回读、seen 追加与统计刷新、
 *       路由注册、run-now 的三种失败态（无目标会话 / 总开关关着 / 会话不在运行）、
 *       以及 followup 真的被调到。
 *
 * 用法：
 *   node tools/smoke-test.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { register } from 'node:module'

/**
 * ⚠️ 离线进程里没有宿主的模块解析：`lib/index.js` 会 `import '@deepseek-ai/dsh-llm'`
 * （用官方 `createUserMessage` 补 role/id）。这里用 loader 钩子把它指向等价 stub，
 * 否则 `node tools/smoke-test.mjs` 直接 ERR_MODULE_NOT_FOUND（2026-10-16 踩到）。
 */
register('./dsh-llm-stub-hooks.mjs', import.meta.url)
await new Promise((resolve) => { setImmediate(resolve) }) // 等 hooks 线程就绪，避免注册竞态

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-duty-smoke-'))
process.env.DSH_HOME = TMP

const WORKSPACE = path.join(TMP, 'workspace')
fs.mkdirSync(path.join(WORKSPACE, 'prompts'), { recursive: true })

let pass = 0
let fail = 0
const check = (name, cond, detail) => {
  if (cond) {
    pass += 1
    console.log(`  ok   ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`)
  }
}

// ── 假 ctx ──────────────────────────────────────────────────────────────
const routes = new Map()
const registeredTools = []
const followups = []
const intervals = []
const timers = []
const effects = []

/**
 * ⚠️ 照抄 DSH session format v4 对 `message.source` 的真实校验（见 dsh-session 的 format 实现）：
 *   `typeof kind !== 'string' || kind.length === 0 || kind === 'plugin'` ⇒ 抛
 *     `format v4 message requires a producer-owned source kind`
 *
 * 为什么必须搬进 mock：真实踩过一次 —— 我给 followup 传了 `{ kind: 'plugin', plugin: 'bili-duty' }`，
 * 结果**定时唤醒与延迟复核在真实环境里从未投递成功过**，界面只显示「本轮运行失败」，
 * 而当时的 mock 照单全收，所以 235 项测试全绿也没发现。
 * 教训：mock 必须复制真实约束，不能只记录调用。
 */
function assertValidMessageSource(message) {
  const source = message?.source
  const bad = !source || typeof source !== 'object' || Array.isArray(source)
    || typeof source.kind !== 'string' || source.kind.length === 0 || source.kind === 'plugin'
  if (bad) throw new Error('format v4 message requires a producer-owned source kind')
  // 网关还要求 role：手拼裸对象会写出缺 role 的消息，之后该会话每次请求都被拒
  // （`messages[N]: missing field role`）。这条断言就是防止再退回裸对象。
  if (typeof message?.role !== 'string' || message.role.length === 0) {
    throw new Error('message is missing role (must come from createUserMessage)')
  }
  return true
}

const fakeAgents = {
  list: () => [
    { id: 'session-alpha', session: { title: '主会话', cwd: WORKSPACE }, status: 'idle' },
    { id: 'session-beta', session: { title: '副会话', cwd: WORKSPACE }, status: 'idle' },
  ],
  get: (id) => (id === 'session-alpha' || id === 'session-beta'
    ? {
      id,
      followup: (message) => {
        assertValidMessageSource(message) // 真实校验，别让非法 source 蒙混过关
        if (!Array.isArray(message?.content) || message.content.length === 0) {
          throw new Error('followup 需要非空的 content')
        }
        followups.push({ id, payload: message })
      },
    }
    : undefined),
}

const taps = []
const fakeWebServer = {
  register: (route) => {
    if (routes.has(route.path)) throw new Error(`webserver: duplicate exact route "${route.path}"`)
    routes.set(route.path, route.handler)
    return () => { routes.delete(route.path) }
  },
  tapIndex: (transform) => {
    taps.push(transform)
    return () => { taps.splice(taps.indexOf(transform), 1) }
  },
}

/** 会话标题（可变：用来验证"重命名后是否立刻反映"，即它必须是动态读取而非手写映射） */
const sessionTitles = new Map([
  ['session-alpha', '创建DSH插件'],
  ['session-aaa-1111-2222-3333-444455556666', '刷 B站'],
])

const ctx = {
  get: (name) => {
    if (name === 'agents') return fakeAgents
    if (name === 'timer') return { timeout: ctx.timeout, interval: ctx.interval }
    if (name === 'tools') return { register: (spec) => { registeredTools.push(spec); return () => {} } }
    if (name === 'webServer') return fakeWebServer
    // 首选来源：全量会话 + 批量标题（live 优先）
    if (name === 'sessionQuery') {
      return {
        listSessions: async () => ([
          { id: 'session-aaa-1111-2222-3333-444455556666', identity: { cwd: 'C:\\Users\\AA\\Desktop\\日常' }, createdAt: Date.now() - 86400000 },
          { id: 'session-bbb-1111-2222-3333-444455556666', identity: { cwd: 'C:\\Users\\AA\\Desktop\\插件' }, createdAt: Date.now() - 3600000 },
          { id: 'session-alpha', identity: { cwd: 'E:\\AI\\deepseek\\插件' }, createdAt: Date.now() },
        ]),
        readTitleSnapshots: async (ids) => ids.map((id) => ({
          sessionId: id,
          // 故意套一层没人见过的结构，用来验证宽容解析（deepFindTitle）
          observation: { title: { val: sessionTitles.get(id) ?? '' } },
        })),
      }
    }
    // 次选来源（首选失败时才用）
    if (name === 'sessionController') {
      return {
        list: async () => ({
          sessions: [
            { id: 'session-aaa-1111-2222-3333-444455556666', title: '刷 B站', updatedAt: Date.now() - 86400000 },
            { id: 'session-alpha', title: '主会话', updatedAt: Date.now() },
          ],
        }),
      }
    }
    return undefined
  },
  interval: (cb, ms) => { intervals.push({ cb, ms }); return () => {} },
  timeout: (cb, ms) => { timers.push({ cb, ms }); return () => {} },
  // 与真实 cordis 一致：effect 回调立刻执行，返回值是清理函数。
  effect: (cb) => {
    const cleanup = cb()
    effects.push(cleanup)
    return () => {
      if (typeof cleanup === 'function') cleanup()
      effects.splice(effects.indexOf(cleanup), 1)
    }
  },
  logger: () => () => {},
}

// ── 假的 req / res ─────────────────────────────────────────────────────
function fakeReq(method = 'GET', url = '/', body = null, headers = {}) {
  const listeners = {}
  const req = {
    method,
    url,
    headers,
    on: (event, fn) => {
      listeners[event] = listeners[event] || []
      listeners[event].push(fn)
      if (event === 'end') {
        queueMicrotask(() => {
          if (body !== null) for (const fn of listeners.data || []) fn(Buffer.from(body, 'utf8'))
          for (const fn of listeners.end || []) fn()
        })
      }
      return req
    },
    destroy: () => {},
  }
  return req
}

function fakeRes() {
  const res = { status: 0, headers: null, body: '' }
  res.writeHead = (code, headers) => { res.status = code; res.headers = headers }
  res.end = (chunk) => { if (chunk) res.body += chunk }
  return res
}

async function callRoute(pathname, { method = 'GET', body = null, search = '', headers = {} } = {}) {
  const handler = routes.get(pathname)
  if (!handler) throw new Error(`route not registered: ${pathname}`)
  const res = fakeRes()
  await handler(fakeReq(method, `${pathname}${search}`, body, headers), res)
  let parsed = null
  try { parsed = JSON.parse(res.body) } catch (err) { parsed = res.body }
  return { status: res.status, data: parsed }
}

const tool = (name) => {
  const found = registeredTools.find((t) => t.name === name)
  if (!found) throw new Error(`tool not registered: ${name}`)
  return found
}

// ── 开跑 ────────────────────────────────────────────────────────────────
const mod = await import('../lib/index.js')

console.log(`\n[1] 模块与注册（DSH_HOME=${TMP}）`)
check('导出了 apply', typeof mod.apply === 'function')
check('导出了 inject=[timer, tools]', JSON.stringify(mod.inject) === '["timer","tools"]', mod.inject)

mod.apply(ctx, {})

check('注册了 13 个工具', registeredTools.length === 13, registeredTools.map((t) => t.name))
for (const name of ['bili_duty_info', 'bili_duty_run_add', 'bili_duty_seen_query', 'bili_duty_seen_add', 'bili_duty_verify_in', 'bili_duty_comment_send', 'bili_duty_login_start', 'bili_duty_login_poll', 'bili_duty_whoami', 'bili_duty_search', 'bili_duty_video', 'bili_duty_subtitles', 'bili_duty_comments']) {
  check(`工具存在：${name}`, registeredTools.some((t) => t.name === name))
}
check('注册了 10 条路由', routes.size === 10, [...routes.keys()])
check('起了 1 个定时器（60 秒跳）', intervals.length === 1 && intervals[0].ms === 60000, intervals.map((i) => i.ms))
check('注册了清理 effect（1 个定时器 + 10 条路由；page_probe 默认关闭 → 无 index 注入）', effects.length === 11, effects.length)

// 页面自检脚本默认**不**注入（安全审查 S6：它往宿主页面塞 <script> 并回报 URL，默认必须是关的）
{
  check('page_probe 默认关闭 → 没有 index 注入', taps.length === 0, taps.length)
}

// 卸载必须把路由全部放掉，否则重载时 webServer 会以 duplicate route 拒绝激活（实测踩过）。
for (const dispose of effects) if (typeof dispose === 'function') dispose()
check('卸载后路由全清空', routes.size === 0, [...routes.keys()])
check('卸载后 index 注入也撤销', taps.length === 0, taps.length)
mod.apply(ctx, {})
check('重载后能重新注册（无 duplicate）', routes.size === 10 && registeredTools.length === 26, { routes: routes.size, tools: registeredTools.length })

console.log('\n[1.5] 客户端半自检：心跳回执与诊断路由')
{
  const missing = await callRoute('/bili-duty/client-modules.json')
  check('诊断路由可用（clientModules 缺失时如实报错）', missing.status === 200 && missing.data.ok === false, missing.data)
  check('hello 只认 POST', (await callRoute('/bili-duty/hello')).status === 405)

  const beat = await callRoute('/bili-duty/hello', {
    method: 'POST',
    body: JSON.stringify({ phase: 'applied', detail: 'slots/style 已注册', href: 'http://127.0.0.1:43189/', loader: 'object', ua: 'test-agent' }),
  })
  check('心跳被接收', beat.status === 200 && beat.data.ok === true, beat.data)

  const st = await callRoute('/bili-duty/state.json')
  check('state 里带上了客户端回执', st.data.clientDiag && st.data.clientDiag.phase === 'applied', st.data.clientDiag)
  check('回执记了时间与页面地址', Boolean(st.data.clientDiag.at) && st.data.clientDiag.href === 'http://127.0.0.1:43189/', st.data.clientDiag)
  check('回执里不含敏感信息（无 token/cookie）', !/token|cookie|secret/iu.test(JSON.stringify(st.data.clientDiag)), st.data.clientDiag)

  const bad = await callRoute('/bili-duty/hello', { method: 'POST', body: '{oops' })
  check('坏 JSON 被拒', bad.status === 400 && bad.data.ok === false, bad.data)
}

console.log('\n[2] 默认配置（未存过任何东西时）')
const info0 = await tool('bili_duty_info').execute({}, {})
check('enabled 默认 true', info0.enabled === true)
check('关键词回落到内置 5 组', info0.keywords.length === 5, info0.keywords)
check('lookback_days=7', info0.lookback_days === 7)
check('max_comment_reads=10', info0.max_comment_reads === 10)
check('auto_comment 默认 false', info0.auto_comment === false)
check('schedule.mode 默认 manual', info0.schedule.mode === 'manual')
check('report_detail 默认 full', info0.report_detail === 'full')
check('verify_delay_minutes 默认 10', info0.verify_delay_minutes === 10)
check('没配工作区时落回插件家目录', info0.paths.seen.startsWith(TMP), info0.paths.seen)

console.log('\n[3] run-now：未指定目标会话 → 失败并写 runs')
const r1 = await callRoute('/bili-duty/run-now', { method: 'POST' })
check('返回 409', r1.status === 409, r1)
check('code=NO_TARGET', r1.data.code === 'NO_TARGET', r1.data)
check('run-now 只认 POST', (await callRoute('/bili-duty/run-now')).status === 405)
{
  const runsFile = path.join(TMP, 'bili-duty', 'runs.md')
  const text = fs.readFileSync(runsFile, 'utf8')
  check('runs.md 被自动创建并带表头', text.includes('| 时间 | 触发 | 结果 |'), text.split('\n')[0])
  check('失败也写了行', text.includes('NO_TARGET') || text.includes('还没指定目标会话'), text)
}

console.log('\n[4] 保存配置（走设置页那条 POST 路由）')
const saved = await callRoute('/bili-duty/config.json', {
  method: 'POST',
  body: JSON.stringify({
    workspace: WORKSPACE,
    target_session_id: 'session-alpha',
    keywords: '深度学习\nDSH 插件\n',
    lookback_days: 3,
    max_items_per_run: 8,
    schedule: { mode: 'daily', at: '7:05', weekdays: [1, 3, 9] },
    report_detail: 'thin',
  }),
})
check('POST 返回 200', saved.status === 200, saved)
check('关键词按换行解析成 2 条', saved.data.config.keywords.length === 2, saved.data.config.keywords)
check('lookback_days=3', saved.data.config.lookback_days === 3)
check('at 被规范成 07:05', saved.data.config.schedule.at === '07:05', saved.data.config.schedule.at)
check('非法星期 9 被丢掉、剩下的排序', JSON.stringify(saved.data.config.schedule.weekdays) === '[1,3]', saved.data.config.schedule.weekdays)
check('落盘了 config.json', fs.existsSync(path.join(TMP, 'bili-duty', 'config.json')))

console.log('\n[5] run-now：目标会话在运行 → 真的 followup')
const r2 = await callRoute('/bili-duty/run-now', { method: 'POST' })
check('返回 200', r2.status === 200, r2.data)
check('code=WOKEN', r2.data.code === 'WOKEN', r2.data)
check('followup 被调用', followups.length === 1, followups.length)
{
  const payload = followups[0]?.payload
  const text = payload?.content?.[0]?.text ?? ''
  // ⚠️ 这里曾经断言的是 `kind === 'plugin'` —— 而那个值正是被 DSH 拒绝的。
  // 断言"合法"而不是"等于某个具体值"，免得下次又把它写死成错的。
  check('followup 的 source 合法（kind 为自己所有、非空、不是被禁的 plugin）',
    payload?.source?.kind === 'bili-duty', payload?.source)
  check('消息里有本轮关键词', text.includes('DSH 插件'))
  check('消息里有目标路径（判重表）', text.includes(path.join(WORKSPACE, 'seen.md')), text.slice(0, 200))
  check('消息里钉了「因无字幕跳过 N 条」纪律', text.includes('因无字幕跳过 N 条'))
  check('消息里钉了 BV 校验纪律', text.includes('x/web-interface/view'))
  check('自动评论关着时明说「一个字都不许发」', text.includes('一个字都不许发'))
}

console.log('\n[6] 工具：run_add / seen_add / seen_query')
{
  const out = await tool('bili_duty_run_add').execute({
    trigger: 'manual', result: 'partial', scanned: 4, kept: 1, skipped: 2, no_subtitle: 0, comments: 0, note: '冒烟测试',
  }, {})
  check('run_add ok', out.ok === true, out)
  const hist = await callRoute('/bili-duty/history.json', { search: '?limit=50' })
  check('history 可读', hist.data.readable === true, hist.data)
  check('最新一行在表头', hist.data.rows[0]?.note === '冒烟测试', hist.data.rows[0])
  check('无字幕列写了 0', hist.data.rows[0]?.noSubtitle === 0)
  check('历史行数 = 2（[3] 的两条失败发生在还没配工作区时，落在插件家目录）', hist.data.total === 2, hist.data.total)
  check('插件家目录里也留了那两条', fs.readFileSync(path.join(TMP, 'bili-duty', 'runs.md'), 'utf8').includes('还没指定目标会话'))
}
{
  const out = await tool('bili_duty_seen_add').execute({
    bv: 'BV1TEST000001', disposition: '收取', reason: '冒烟：DSH 桌面端相关',
  }, {})
  check('seen_add ok', out.ok === true, out)
  const seenFile = path.join(WORKSPACE, 'seen.md')
  const text = fs.readFileSync(seenFile, 'utf8')
  check('seen.md 写进工作区', fs.existsSync(seenFile))
  check('自动建了表头', text.includes('| BV号 | 首次见到 | 处置 | 理由 | 评论 |'))
  check('统计区被刷新（累计收取 1）', text.includes('累计收取：1'), text.slice(-200))

  const q1 = await tool('bili_duty_seen_query').execute({ bv: 'bv1test000001' }, {})
  check('查询大小写不敏感命中', q1.found === 1, q1)
  const q2 = await tool('bili_duty_seen_query').execute({ bv: 'BV1NOTEXIST99' }, {})
  check('没记录的返回 found=0 且 readable=true', q2.readable === true && q2.found === 0, q2)
  const q3 = await tool('bili_duty_seen_query').execute({ query: '冒烟' }, {})
  check('关键词模糊搜命中', q3.found >= 1, q3)
}

console.log('\n[7] seen 读不出来时不许当成"没记录过"')
{
  const saved = fs.readFileSync(path.join(WORKSPACE, 'seen.md'), 'utf8')
  fs.rmSync(path.join(WORKSPACE, 'seen.md'))
  fs.mkdirSync(path.join(WORKSPACE, 'seen.md'), { recursive: true }) // 目录占位 → 读必失败
  const q = await tool('bili_duty_seen_query').execute({ bv: 'BV1TEST000001' }, {})
  check('返回 readable=false', q.readable === false, q)
  check('带上了铁律提示', String(q.rule || '').includes('不许当成'), q.rule)
  fs.rmdirSync(path.join(WORKSPACE, 'seen.md'))
  fs.writeFileSync(path.join(WORKSPACE, 'seen.md'), saved, 'utf8')
}

console.log('\n[8] verify_in：排延迟复核')
{
  const before = timers.length
  const out = await tool('bili_duty_verify_in').execute({
    target: 'BV1TEST000001 的评论', expected: '评论数 499→500',
  }, {})
  check('排上了定时器', timers.length === before + 1, timers.length)
  check('延迟 = 设置里的 10 分钟', out.delayMinutes === 10, out)
  check('返回了到期时刻', typeof out.scheduledFor === 'string', out)
  const followupsBefore = followups.length
  timers[timers.length - 1].cb()
  check('到期后投递了复核提醒', followups.length === followupsBefore + 1, followups.length)
  const text = followups[followups.length - 1].payload.content[0].text
  check('提醒里含复核纪律', text.includes('不得判失败'), text)
}

console.log('\n[9] comment_send：未登录时明确要求登录（不许假装能发）')
{
  // ⚠️ 0.1.2 起发评论前面多了代码级护栏，这条用例必须先摆平「总开关 + @ 对象」，
  // 否则会被 AUTO_COMMENT_OFF / NO_AT 先拦下，测不到"未登录"这一层。
  // （护栏本身在 [17] 有专门用例。）
  await callRoute('/bili-duty/config.json', {
    method: 'POST',
    body: JSON.stringify({ ...saved.data.config, auto_comment: true, comment_at: '某人' }),
  })
  const out = await tool('bili_duty_comment_send').execute({ bv: 'BV1TEST000001', text: '测试正文' }, {})
  check('ok=false', out.ok === false, out)
  check('明确标出 needLogin（而不是假装发成功）', out.needLogin === true, out)
  check('给出了怎么登录', String(out.howTo || '').includes('login_start'), out.howTo)
  check('也写了失败原因', String(out.error || '').includes('登录'), out.error)
  // 恢复原配置，别把 auto_comment=true 带进后面的用例
  await callRoute('/bili-duty/config.json', { method: 'POST', body: JSON.stringify(saved.data.config) })
}

console.log('\n[10] enabled=false → 一切停跑')
{
  await callRoute('/bili-duty/config.json', { method: 'POST', body: JSON.stringify({ ...saved.data.config, enabled: false }) })
  const followupsBefore = followups.length
  const r = await callRoute('/bili-duty/run-now', { method: 'POST' })
  check('手动触发也被拦', r.status === 409 && r.data.code === 'DISABLED', r.data)
  check('没有新增 followup', followups.length === followupsBefore)
  const info = await tool('bili_duty_info').execute({}, {})
  check('info 里 enabled=false', info.enabled === false)
  const hist = await callRoute('/bili-duty/history.json', { search: '?limit=5' })
  check('停跑也写了 runs 行', hist.data.rows[0]?.note.includes('enabled=false') || hist.data.rows[0]?.note.includes('总开关'), hist.data.rows[0])
}

console.log('\n[11] 定时器到点判定（daily 07:05 / 谷时）')
{
  await callRoute('/bili-duty/config.json', {
    method: 'POST',
    body: JSON.stringify({ ...saved.data.config, enabled: true, schedule: { mode: 'daily', at: '07:05', weekdays: [] } }),
  })
  const before = followups.length
  const tick = intervals[intervals.length - 1].cb // 用最后一次 apply 起的那个定时器
  tick() // 现在多半不是 07:05，不该触发
  check('非计划时刻不触发', followups.length === before, followups.length - before)

  // 把计划改成"当前时刻"，刚过点 → 应触发（并受谷时限制）
  const now = new Date()
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  await callRoute('/bili-duty/config.json', {
    method: 'POST',
    body: JSON.stringify({ ...saved.data.config, enabled: true, off_peak_only: false, schedule: { mode: 'daily', at: hhmm, weekdays: [] } }),
  })
  intervals[intervals.length - 1].cb()
  check('到点触发 followup', followups.length === before + 1, followups.length - before)
  intervals[intervals.length - 1].cb()
  check('同一天不重复触发', followups.length === before + 1, followups.length - before)
}

console.log('\n[12] webServer 后到（冷启动竞态）：路由必须等服务就绪后补上')
{
  // 真实环境踩过的坑：apply 跑在 webServer 就绪之前，ctx.get 拿到 undefined，
  // 结果 7 条面板路由一条都没注册（fiber 却是 active）—— 外面看就是 /bili-duty/*.json 全 404。
  const lateRoutes = new Map()
  const lateTaps = []
  const injectRequests = []
  const lateTools = []
  const lateWebServer = {
    register: (route) => {
      if (lateRoutes.has(route.path)) throw new Error(`webserver: duplicate exact route "${route.path}"`)
      lateRoutes.set(route.path, route.handler)
      return () => { lateRoutes.delete(route.path) }
    },
    tapIndex: (transform) => { lateTaps.push(transform); return () => { lateTaps.splice(lateTaps.indexOf(transform), 1) } },
  }
  const scopedCtx = {
    get: (name) => (name === 'webServer' ? lateWebServer : lateCtx.get(name)),
    effect: (cb) => { const c = cb(); effects.push(c); return () => { if (typeof c === 'function') c() } },
    interval: () => () => {},
    timeout: () => () => {},
    logger: () => () => {},
  }
  const lateCtx = {
    // 这一刻 webServer 还不存在
    get: (name) => {
      if (name === 'agents') return fakeAgents
      if (name === 'timer') return { timeout: () => () => {}, interval: () => () => {} }
      if (name === 'tools') return { register: (spec) => { lateTools.push(spec); return () => {} } }
      if (name === 'webServer') return undefined
      return undefined
    },
    interval: () => () => {},
    timeout: () => () => {},
    effect: (cb) => { const c = cb(); effects.push(c); return () => { if (typeof c === 'function') c() } },
    inject: (names, callback) => { injectRequests.push({ names, callback }); return () => {} },
    logger: () => () => {},
  }

  mod.apply(lateCtx, {})
  check('webServer 未就绪时不报错、也不注册路由', lateRoutes.size === 0, [...lateRoutes.keys()])
  check('排了一个 webServer 注入等待', injectRequests.length === 1 && injectRequests[0].names.includes('webServer'), injectRequests.map((r) => r.names))
  check('工具照常注册（不依赖 webServer）', lateTools.length === 13, lateTools.length)

  // 服务就绪 → 触发注入回调
  injectRequests[0].callback(scopedCtx)
  check('就绪后 10 条路由全部补上', lateRoutes.size === 10, [...lateRoutes.keys()])
  check('就绪后 index 注入也不加（page_probe 默认关，安全审查 S6）', lateTaps.length === 0, lateTaps.length)
  check('补上来的路由可用（state.json）', lateRoutes.has('/bili-duty/state.json') && lateRoutes.has('/bili-duty/hello'))
}

console.log('\n[13] 会话清单：列全量 + 标题一一对应 + 谁是活的（用户连踩两个坑）')
{
  const res = await callRoute('/bili-duty/sessions.json')
  const list = res.data.sessions || []
  const byId = (id) => list.find((s) => s.id === id)

  check('走的是首选来源 sessionQuery', res.data.source === 'sessionQuery', res.data.source)
  check('拿到了全量（不只是活着的）', list.length >= 4, list.map((s) => s.id))
  check('不是 fallback', res.data.fallback === false, res.data.fallback)

  // 一一对应：标题必须落在正确的会话上（宽容解析从没见过的嵌套结构里挖出来）
  check('session-alpha 的标题是「创建DSH插件」', byId('session-alpha')?.title === '创建DSH插件', byId('session-alpha'))
  check('冰会话的标题是「刷 B站」', byId('session-aaa-1111-2222-3333-444455556666')?.title === '刷 B站', byId('session-aaa-1111-2222-3333-444455556666'))
  check('没标题的保持空（界面再兜底显示）', byId('session-bbb-1111-2222-3333-444455556666')?.title === '', byId('session-bbb-1111-2222-3333-444455556666'))
  check('工作目录也跟着会话走（不是同一个值）',
    byId('session-alpha')?.cwd === 'E:\\AI\\deepseek\\插件' && byId('session-bbb-1111-2222-3333-444455556666')?.cwd === 'C:\\Users\\AA\\Desktop\\插件',
    list.map((s) => [s.id.slice(-8), s.cwd]))

  check('活着的排在前面', list[0].live === true, list.map((s) => [s.id, s.live]))
  check('活会话被标 live', byId('session-alpha')?.live === true)
  check('冷会话标 live=false', byId('session-aaa-1111-2222-3333-444455556666')?.live === false)
  check('活着但没落盘的会话也被补进来', byId('session-beta')?.live === true, list.map((s) => s.id))

  // ★ 关键：重命名必须立刻反映 —— 证明它是动态读取，不是任何手写映射
  sessionTitles.set('session-alpha', '改了个名字')
  const renamed = await callRoute('/bili-duty/sessions.json')
  check('重命名后立刻反映（不是手写映射）',
    renamed.data.sessions.find((s) => s.id === 'session-alpha')?.title === '改了个名字',
    renamed.data.sessions.find((s) => s.id === 'session-alpha'))

  await callRoute('/bili-duty/config.json', {
    method: 'POST',
    body: JSON.stringify({ ...saved.data.config, target_session_id: 'session-alpha' }),
  })
  check('选中活会话后 sessionLive=true', (await callRoute('/bili-duty/state.json')).data.sessionLive === true)
  await callRoute('/bili-duty/config.json', {
    method: 'POST',
    body: JSON.stringify({ ...saved.data.config, target_session_id: 'session-aaa-1111-2222-3333-444455556666' }),
  })
  check('选中冷会话时 sessionLive=false（界面要提示先打开它）', (await callRoute('/bili-duty/state.json')).data.sessionLive === false)
}

console.log('\n[14] 写盘失败不许把宿主带走（对照 dsh-bili-scroll 的真实 issue #1）')
{
  // 它的 issue：duty.log 被占用 → appendFileSync 抛 EBUSY → 未捕获异常**直接终止整个 DSH 宿主**。
  // 我们同架构，所以必须保证：任何写盘失败都只是"如实返回失败"，绝不上抛。
  const badWs = path.join(TMP, 'bad-workspace')
  fs.mkdirSync(path.join(badWs, 'runs.md'), { recursive: true }) // 用目录占住 runs.md ⇒ 写入必失败
  fs.mkdirSync(path.join(badWs, 'seen.md'), { recursive: true }) // 同理占住 seen.md
  await callRoute('/bili-duty/config.json', {
    method: 'POST',
    body: JSON.stringify({ ...saved.data.config, workspace: badWs, target_session_id: 'session-alpha' }),
  })

  let threw = null
  let out = null
  try {
    out = await tool('bili_duty_run_add').execute({ trigger: 'manual', result: 'ok', note: '写盘失败测试' }, {})
  } catch (err) {
    threw = err
  }
  check('run_add 写盘失败时不抛', threw === null, threw && threw.message)
  check('run_add 如实返回 ok:false + 原因', Boolean(out) && out.ok === false && typeof out.error === 'string', out)
  check('返回里带上了文件路径（便于排查）', Boolean(out) && typeof out.file === 'string', out && out.file)

  let seenThrew = null
  let seenOut = null
  try {
    seenOut = await tool('bili_duty_seen_add').execute({ bv: 'BV1BAD0000001', disposition: '跳过', reason: '写盘失败测试' }, {})
  } catch (err) {
    seenThrew = err
  }
  check('seen_add 写盘失败时不抛', seenThrew === null, seenThrew && seenThrew.message)
  check('seen_add 如实返回 ok:false', Boolean(seenOut) && seenOut.ok === false, seenOut)

  // 路由路径最关键：旧代码在这里会把异常漏出 handler（没有任何调用方接得住）
  let routeThrew = null
  let status = null
  try {
    status = (await callRoute('/bili-duty/run-now', { method: 'POST' })).status
  } catch (err) {
    routeThrew = err
  }
  check('run-now 在写盘失败时仍返回结构化响应（不抛）', routeThrew === null, routeThrew && routeThrew.message)
  check('run-now 的状态码是 200/409 之一', status === 200 || status === 409, status)

  // 收尾：把工作区换回去，免得影响后续断言
  await callRoute('/bili-duty/config.json', {
    method: 'POST',
    body: JSON.stringify({ ...saved.data.config, target_session_id: 'session-alpha' }),
  })
}

console.log('\n[15] 路由来源校验（防 CSRF：本机任意网页都能 POST 我们的路由）')
{
  // 正常情况：宿主内部 / curl 不带来源头 ⇒ 放行
  check('无来源头放行（宿主内部调用）', (await callRoute('/bili-duty/state.json')).status === 200)

  // 本机来源 ⇒ 放行
  const loopback = await callRoute('/bili-duty/state.json', {
    headers: { host: '127.0.0.1:43189', origin: 'http://127.0.0.1:43189' },
  })
  check('回环 Origin 放行', loopback.status === 200, loopback.status)

  // 恶意网页 ⇒ 写请求必须被拒（这是 CSRF 那一刀）
  const evil = await callRoute('/bili-duty/run-now', {
    method: 'POST',
    headers: { host: '127.0.0.1:43189', origin: 'https://evil.example' },
  })
  check('外部 Origin 的 POST 被拒（403）', evil.status === 403, evil)

  const evilConfig = await callRoute('/bili-duty/config.json', {
    method: 'POST',
    body: JSON.stringify({ enabled: false }),
    headers: { host: '127.0.0.1:43189', origin: 'https://evil.example' },
  })
  check('外部 Origin 改配置也被拒', evilConfig.status === 403, evilConfig.status)

  // 恶意 referer 同样拒
  const evilRef = await callRoute('/bili-duty/run-now', {
    method: 'POST',
    headers: { host: '127.0.0.1:43189', referer: 'https://evil.example/page' },
  })
  check('外部 Referer 的 POST 被拒', evilRef.status === 403, evilRef.status)

  // DNS rebinding：Host 头不是回环 ⇒ 拒
  const rebind = await callRoute('/bili-duty/state.json', { headers: { host: 'evil.example' } })
  check('非回环 Host 被拒（DNS rebinding）', rebind.status === 403, rebind)

  // 应用自身协议（桌面壳）⇒ 放行
  const appScheme = await callRoute('/bili-duty/state.json', {
    headers: { host: '127.0.0.1:43189', origin: 'dsh-app://app' },
  })
  check('应用自身协议放行', appScheme.status === 200, appScheme.status)
}

console.log('\n[16] 扫码登录：申请 → 轮询 → 落凭证 → 验身份（全程离线 mock）')
{
  const realFetch = globalThis.fetch
  const makeResponse = (body, setCookies) => ({
    status: 200,
    headers: { getSetCookie: () => setCookies },
    json: async () => body,
  })
  const seen = []
  globalThis.fetch = async (url) => {
    const target = String(url)
    seen.push(target)
    if (target.includes('/qrcode/generate')) {
      return makeResponse({ code: 0, data: { url: 'https://passport.bilibili.com/h5-app/passport/login?k=K', qrcode_key: 'KEY-1' } }, [])
    }
    if (target.includes('/qrcode/poll')) {
      // 关键：凭证在 Set-Cookie 里，不在 body 里
      return makeResponse({ code: 0, data: { code: 0, message: 'ok' } }, [
        'SESSDATA=sess-abc; Path=/; HttpOnly',
        'bili_jct=jct-xyz; Path=/',
        'DedeUserID=99; Path=/',
      ])
    }
    if (target.includes('/finger/spi')) return makeResponse({ code: 0, data: { b_3: 'buvid-3' } }, [])
    if (target.includes('/web-interface/nav')) {
      return makeResponse({ code: 0, data: { isLogin: true, uname: '测试账号', mid: 99 } }, [])
    }
    throw new Error(`未预期的请求：${target}`)
  }

  // 登录前
  const before = await callRoute('/bili-duty/whoami')
  check('登录前 whoami 报告未登录', before.data.loggedIn === false, before.data)

  // 申请二维码
  const started = await callRoute('/bili-duty/login/start', { method: 'POST' })
  check('申请二维码成功', started.status === 200 && started.data.ok === true, started.data)
  check('返回 qrcodeKey', started.data.qrcodeKey === 'KEY-1', started.data.qrcodeKey)
  check('返回 data URL 形式的二维码', String(started.data.svgDataUrl).startsWith('data:image/svg+xml;base64,'))
  const svg = Buffer.from(String(started.data.svgDataUrl).split(',')[1], 'base64').toString('utf8')
  check('二维码是合法 SVG', svg.startsWith('<svg ') && svg.includes('<path fill="#000000"'), svg.slice(0, 60))
  check('二维码里编的是登录链接（格子够多）', (svg.match(/M\d+ \d+h/gu) || []).length > 100, (svg.match(/M\d+ \d+h/gu) || []).length)
  check('二维码没有经过第三方图片服务', !JSON.stringify(started.data).includes('qrserver') && !JSON.stringify(started.data).includes('googleapis'))

  // 轮询 → 成功
  const polled = await callRoute('/bili-duty/login/poll', { method: 'POST', body: JSON.stringify({ qrcodeKey: 'KEY-1' }) })
  check('轮询返回 success', polled.data.status === 'success', polled.data)
  check('拿到身份', polled.data.account?.uname === '测试账号', polled.data.account)
  check('响应里不回传 sessdata', !JSON.stringify(polled.data).includes('sess-abc'), polled.data)

  const credentialFile = path.join(TMP, 'bili-duty', 'bili_credential.json')
  check('凭证已落盘', fs.existsSync(credentialFile))
  const saved = JSON.parse(fs.readFileSync(credentialFile, 'utf8'))
  check('凭证四字段齐全', saved.sessdata === 'sess-abc' && saved.biliJct === 'jct-xyz' && saved.dedeUserId === '99', saved)
  check('buvid3 已补打（spi 接口）', saved.buvid3 === 'buvid-3', saved.buvid3)

  // 登录后
  const after = await callRoute('/bili-duty/whoami')
  check('登录后 whoami 报告已登录', after.data.loggedIn === true, after.data)
  check('whoami 不回传 sessdata', !JSON.stringify(after.data).includes('sess-abc'))
  check('whoami 带上了保存时间', Boolean(after.data.credential?.savedAt), after.data.credential)

  // 没 key 时的报错路径
  const noKey = await callRoute('/bili-duty/login/poll', { method: 'POST', body: JSON.stringify({}) })
  check('没有 key 时明确报错（不是静默）', noKey.status === 400 || noKey.data.status === undefined, noKey.data)

  globalThis.fetch = realFetch
}

console.log('\n[17] 数据通道：搜索 / 详情 / 字幕 / 评论 / 发评论（离线 mock）')
{
  const realFetch = globalThis.fetch
  const makeResponse = (body) => ({
    status: 200,
    headers: { getSetCookie: () => [] },
    json: async () => body,
    text: async () => JSON.stringify(body),
  })
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url)
    calls.push({ url: target, method: options.method || 'GET' })
    if (target.includes('/search/type')) {
      return makeResponse({
        code: 0,
        data: { result: [{ bvid: 'BV1TEST000001', title: '<em class="keyword">DeepSeek</em> Harness 实测', author: '某UP', play: 12345, video_review: 67, duration: '12:30', pubdate: 1792130000, description: '简介…' }] },
      })
    }
    if (target.includes('/x/web-interface/view')) {
      return makeResponse({ code: 0, data: { bvid: 'BV1TEST000001', aid: 999, title: '测试视频', owner: { name: '某UP' }, duration: 750, pubdate: 1792130000, stat: { view: 12345, like: 100, reply: 6 }, desc: '这是简介', pages: [{ page: 1, part: 'P1', cid: 888, duration: 750 }] } })
    }
    if (target.includes('/x/player/wbi/v2')) {
      // 故意把 ai-zh 排在前面、人工轨 zh-Hans 排在后面 —— 用来验证「人工轨优先」而不是「ai 轨优先」
      // （2026-10-16 值班实测：ai-zh 轨的内容不保证是这个视频的）
      return makeResponse({ code: 0, data: { subtitle: { subtitles: [{ lan: 'ai-zh', lan_doc: '中文', subtitle_url: '//aisubtitle.hdslb.com/bfs/ai_subtitle/test.json' }, { lan: 'ai-en', lan_doc: 'English', subtitle_url: '//aisubtitle.hdslb.com/bfs/ai_subtitle/test-en.json' }, { lan: 'zh-Hans', lan_doc: '中文（简体）', subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/manual.json' }] } } })
    }
    if (target.includes('aisubtitle.hdslb.com')) {
      // 最后一行的正文故意带**孤立代理项**：验证 well-formed 兜底。
      // 没有它时，DSH 的工具层会以 `value is not lossless JSON` 拒绝整包返回（值班实测踩到）。
      return makeResponse({ body: [{ from: 0, to: 2, content: '第一句话' }, { from: 2, to: 4, content: '第二句话' }, { from: 4, to: 6, content: '第三句话' }, { from: 6, to: 8, content: '坏\uD800字符' }] })
    }
    if (target.includes('/x/v2/reply/add')) {
      return makeResponse({ code: 0, data: { rpid: 123456789, rpid_str: '123456789' } })
    }
    if (target.includes('/x/v2/reply')) {
      return makeResponse({ code: 0, data: { page: { count: 6 }, replies: [{ rpid_str: '111', member: { uname: '甲' }, like: 10, content: { message: '热评一' }, replies: [] }] } })
    }
    if (target.includes('/x/web-interface/nav')) {
      return makeResponse({ code: 0, data: { isLogin: true, uname: '测试账号', mid: 99 } })
    }
    throw new Error(`未预期的请求：${target}`)
  }

  const search = await tool('bili_duty_search').execute({ keyword: 'DeepSeek Harness', order: 'click', limit: 5 }, {})
  check('搜索返回结果', search.ok === true && search.count === 1, search)
  check('搜索结果剥掉了 HTML 高亮标签', search.videos[0].title === 'DeepSeek Harness 实测', search.videos[0].title)
  check('搜索带上了排序参数', calls.some((c) => c.url.includes('order=click')), calls.map((c) => c.url).slice(0, 3))

  const video = await tool('bili_duty_video').execute({ bv: 'BV1TEST000001' }, {})
  check('视频详情可用', video.ok === true && video.aid === 999, video)
  check('详情带分P的 cid（读字幕要用）', video.pages[0]?.cid === 888, video.pages)

  const subs = await tool('bili_duty_subtitles').execute({ bv: 'BV1TEST000001' }, {})
  check('字幕读到正文', subs.ok === true && subs.text.includes('第一句话'), subs)
  check('字幕列出了可选语言轨', Array.isArray(subs.tracks) && subs.tracks.length === 3, subs.tracks)
  check('默认优先人工中文轨（不是 ai-zh）', subs.lan === 'zh-Hans', subs.lan)
  check('标明依据是字幕原文', subs.basis === '依据：字幕原文', subs.basis)
  // 2026-10-16 修：孤立代理项必须被修成 well-formed，否则 DSH 工具层整包报 value is not lossless JSON
  check('字幕里的孤立代理项被修成 well-formed', !/[\uD800-\uDFFF]/u.test(subs.text), subs.text)
  check('坏字符被换成替换字符 U+FFFD', subs.text.includes('\uFFFD'), subs.text)
  // 2026-10-16 修：精确匹配优先；未命中要如实标 fellBack（会话据此在报告里标注依据）
  const exact = await tool('bili_duty_subtitles').execute({ bv: 'BV1TEST000001', lan: 'ai-en' }, {})
  check('传了 lan 就精确匹配', exact.lan === 'ai-en' && exact.fellBack === false, { lan: exact.lan, fellBack: exact.fellBack })
  const fell = await tool('bili_duty_subtitles').execute({ bv: 'BV1TEST000001', lan: 'ja-JP' }, {})
  check('请求的轨不存在 → 回落人工中文轨并标 fellBack', fell.lan === 'zh-Hans' && fell.fellBack === true, { lan: fell.lan, fellBack: fell.fellBack })

  const page1 = await tool('bili_duty_subtitles').execute({ bv: 'BV1TEST000001', maxLines: 2 }, {})
  check('字幕支持分段读', page1.lineCount === 4 && page1.truncated === true && page1.nextStart === 2, { lineCount: page1.lineCount, truncated: page1.truncated, nextStart: page1.nextStart })
  const page2 = await tool('bili_duty_subtitles').execute({ bv: 'BV1TEST000001', start: 2, maxLines: 2 }, {})
  check('续读能拿到剩下的', page2.text.includes('第三句话') && page2.truncated === false, page2.text)

  const comments = await tool('bili_duty_comments').execute({ bv: 'BV1TEST000001' }, {})
  check('评论可读', comments.ok === true && comments.comments.length === 1, comments)
  check('评论只取必要字段（rpid/正文/点赞）', comments.comments[0].rpid === '111' && comments.comments[0].like === 10, comments.comments[0])
  check('评论默认走热门排序', comments.order === 'hot', comments.order)

  // 0.1.2：复核刚发的评论必须能按时间拉（热门排序看不到低赞评论，实测踩过）
  const latest = await tool('bili_duty_comments').execute({ bv: 'BV1TEST000001', order: 'time' }, {})
  check('评论支持按时间排序（复核用）', latest.ok === true && latest.order === 'time', latest.order)
  check('按时间排序真的换了 sort 参数', calls.some((c) => c.url.includes('sort=0')), calls.map((c) => c.url).slice(-3))
  check('依据文案跟着排序走', latest.basis === '依据：最新评论（按时间排序）', latest.basis)

  // ⚠️ 0.1.2 起发评论有代码级护栏：这一段测的是发送链路本身，
  // 所以先把总开关 / @ 对象摆平、并把每轮额度放宽，避免被护栏挡在前面。
  await callRoute('/bili-duty/config.json', {
    method: 'POST',
    body: JSON.stringify({ ...saved.data.config, auto_comment: true, comment_at: '某人', comment_max_per_run: 5 }),
  })

  const sent = await tool('bili_duty_comment_send').execute({ bv: 'BV1TEST000001', text: '这是一条测试评论', at: '某人' }, {})
  check('发评论返回 rpid', sent.ok === true && sent.rpid === '123456789', sent)
  check('@ 被拼进正文', String(sent.message).startsWith('@某人 '), sent.message)
  check('提醒了必须延迟复核', String(sent.verifyNote).includes('5–10 分钟'), sent.verifyNote)
  const addCall = calls.find((c) => c.url.includes('/x/v2/reply/add'))
  check('发评论用的是 POST', addCall && addCall.method === 'POST', addCall)

  // 超长正文要被拦（150 字上限）
  const tooLong = await tool('bili_duty_comment_send').execute({ bv: 'BV1TEST000001', text: 'x'.repeat(200) }, {})
  check('超 150 字的正文被拦住', tooLong.ok === false && String(tooLong.error).includes('150'), tooLong.error)

  // ── 0.1.2 新增：护栏用例（三条红线必须由代码强制，被拒时既不许发请求、也要写 runs.md）──
  const addCallsBefore = calls.filter((c) => c.url.includes('/x/v2/reply/add')).length
  const runsBefore = (await callRoute('/bili-duty/history.json', { search: '?limit=50' })).data.rows.length
  const setConfig = (patchConfig) => callRoute('/bili-duty/config.json', {
    method: 'POST',
    body: JSON.stringify({ ...saved.data.config, ...patchConfig }),
  })

  // ① 总开关关着
  await setConfig({ auto_comment: false, comment_at: '某人' })
  const off = await tool('bili_duty_comment_send').execute({ bv: 'BV1TEST000002', text: '不该发出去', at: '某人' }, {})
  check('护栏①：自动评论关着 → AUTO_COMMENT_OFF', off.ok === false && off.code === 'AUTO_COMMENT_OFF', off)

  // ② 没有 @ 对象（设置里空着，本次也没传）
  await setConfig({ auto_comment: true, comment_at: '' })
  const noAt = await tool('bili_duty_comment_send').execute({ bv: 'BV1TEST000002', text: '不该发出去' }, {})
  check('护栏②：没有 @ 对象 → NO_AT', noAt.ok === false && noAt.code === 'NO_AT', noAt)

  // ③ 同一视频只评一次（先把它记进判重表，模拟评过）
  await setConfig({ auto_comment: true, comment_at: '某人', comment_max_per_run: 5 })
  await tool('bili_duty_seen_add').execute({ bv: 'BV1TEST000001', disposition: '已评论', reason: '护栏用例：模拟已评过', comment: 'rpid 123456789' }, {})
  const dup = await tool('bili_duty_comment_send').execute({ bv: 'BV1TEST000001', text: '不该重复发', at: '某人' }, {})
  check('护栏③：同一视频只评一次 → ALREADY_COMMENTED', dup.ok === false && dup.code === 'ALREADY_COMMENTED', dup)

  // ④ 判重表读不出来（铁律：不许当成"没记录过"）
  //    放在额度用例之前 —— 否则会被 BUDGET_USED 抢先拦下，测不到这一层。
  await setConfig({ auto_comment: true, comment_at: '某人', comment_max_per_run: 5 })
  const seenFile = path.join(WORKSPACE, 'seen.md')
  const seenBackup = fs.readFileSync(seenFile, 'utf8')
  fs.rmSync(seenFile)
  fs.mkdirSync(seenFile) // 变成目录 → readFileSync 必抛，等价于"表读不出来"
  const unreadable = await tool('bili_duty_comment_send').execute({ bv: 'BV1TEST000008', text: '不该发出去', at: '某人' }, {})
  check('护栏④：判重表读不出来 → SEEN_UNREADABLE', unreadable.ok === false && unreadable.code === 'SEEN_UNREADABLE', unreadable)
  fs.rmdirSync(seenFile)
  fs.writeFileSync(seenFile, seenBackup, 'utf8')
  check('判重表已复原（护栏用例没污染后面的用例）', fs.readFileSync(seenFile, 'utf8') === seenBackup)

  // ⑤ ①～④ 全是被拒的调用：一个发评论请求都不许发出去
  const addCallsAfterDenied = calls.filter((c) => c.url.includes('/x/v2/reply/add')).length
  check('护栏⑤：被拒的调用没发出任何发评论请求', addCallsAfterDenied === addCallsBefore, { addCallsBefore, addCallsAfterDenied })

  // ⑥ 每轮额度用尽（上限设 1，连发两条 —— 第二次必被拦，与起点无关）
  await setConfig({ auto_comment: true, comment_at: '某人', comment_max_per_run: 1 })
  await tool('bili_duty_comment_send').execute({ bv: 'BV1TEST000006', text: '额度内的第一条', at: '某人' }, {})
  const over = await tool('bili_duty_comment_send').execute({ bv: 'BV1TEST000007', text: '超额的那条', at: '某人' }, {})
  check('护栏⑥：每轮额度用尽 → BUDGET_USED', over.ok === false && over.code === 'BUDGET_USED', over)
  const addCallsAfterBudget = calls.filter((c) => c.url.includes('/x/v2/reply/add')).length
  check('护栏⑥：超额那次没发出请求', addCallsAfterBudget - addCallsAfterDenied <= 1, { addCallsAfterDenied, addCallsAfterBudget })

  // ⑦ 被拒也要写 runs.md（失败不许静默）
  const runsAfter = (await callRoute('/bili-duty/history.json', { search: '?limit=50' })).data.rows.length
  check('护栏⑦：被拒也写了 runs.md', runsAfter > runsBefore, { runsBefore, runsAfter })
  // history 是反序（最新在前），所以这里要"存在任意一条"，不能只认第一条
  const deniedRows = (await callRoute('/bili-duty/history.json', { search: '?limit=50' })).data.rows
    .filter((r) => String(r.note).includes('拒绝发评论'))
  check('runs.md 里写清了拒绝码', deniedRows.some((r) => r.note.includes('AUTO_COMMENT_OFF'))
    && deniedRows.some((r) => r.note.includes('SEEN_UNREADABLE'))
    && deniedRows.some((r) => r.note.includes('ALREADY_COMMENTED'))
    && deniedRows.some((r) => r.note.includes('BUDGET_USED')),
  deniedRows.map((r) => String(r.note).slice(0, 40)))

  // 收尾：配置恢复原样，别把 auto_comment=true 留在后面
  await setConfig({})

  globalThis.fetch = realFetch
}

console.log('\n[18] 唤醒消息的 source 必须合法（真实踩过：kind="plugin" 被 DSH 拒绝）')
{
  // 回归：mock 的校验必须能识别出我当初写的那个非法形状
  let rejected = false
  try {
    assertValidMessageSource({ source: { kind: 'plugin', plugin: 'bili-duty' } })
  } catch (err) {
    rejected = String(err.message).includes('producer-owned')
  }
  check('mock 校验能识别 kind="plugin"（防止再犯）', rejected === true)

  // 真实发出的每一条 followup，source 都必须是合法的
  const allValid = followups.every((item) => {
    try {
      assertValidMessageSource(item.payload)
      return true
    } catch (err) {
      return false
    }
  })
  check(`已发出的 ${followups.length} 条 followup 全部通过 source 校验`, allValid)
  const kinds = [...new Set(followups.map((item) => item.payload?.source?.kind))]
  check('用的是我们自己的 kind（不是 plugin）', kinds.length > 0 && !kinds.includes('plugin'), kinds)
  check('source 只带 kind（不塞多余字段）',
    followups.every((item) => Object.keys(item.payload.source).length === 1),
    followups.map((item) => Object.keys(item.payload.source)))
}

console.log('\n[19] 安全修复回归（S1 凭证白名单 / S3 workspace / S6 自检开关 / S11 峰时 / D1+D2 二维码 / D4 @ 清洗）')
{
  // ① S6：page_probe 默认关闭；显式打开后才注入
  const cfgFile = path.join(TMP, 'bili-duty', 'config.json')
  fs.writeFileSync(cfgFile, JSON.stringify({ page_probe: true }), 'utf8')
  for (const dispose of effects.splice(0)) if (typeof dispose === 'function') dispose()
  taps.length = 0
  mod.apply(ctx, {})
  const html = '<html><head><title>t</title></head><body></body></html>'
  const injected = taps[0] ? taps[0](html) : ''
  check('page_probe=true → index 注入生效', taps.length === 1 && injected.includes('data-bili-duty-probe'), taps.length)
  check('注入的是 /plugins/bili-duty/client.js', injected.includes('/plugins/bili-duty/client.js'))
  check('已有探头时不重复注入', taps[0](injected) === injected)
  fs.writeFileSync(cfgFile, JSON.stringify({ page_probe: false }), 'utf8')
  for (const dispose of effects.splice(0)) if (typeof dispose === 'function') dispose()
  taps.length = 0
  mod.apply(ctx, {}) // 恢复默认后继续

  // ② S1：凭证只准发往 https 的 B 站自家域
  const { assertTrustedHttpsUrl } = await import('../lib/bili-login.js')
  const allowed = (u) => { try { assertTrustedHttpsUrl(u); return true } catch (err) { return false } }
  check('允许 https://aisubtitle.hdslb.com/…', allowed('https://aisubtitle.hdslb.com/bfs/ai_subtitle/x.json'))
  check('允许 https://api.bilibili.com/…', allowed('https://api.bilibili.com/x/y'))
  check('拒绝明文 http://', !allowed('http://aisubtitle.hdslb.com/x.json'))
  check('拒绝外域 https://evil.example/x.json', !allowed('https://evil.example/x.json'))
  check('拒绝后缀伪装 https://hdslb.com.evil.example/x', !allowed('https://hdslb.com.evil.example/x'))
  check('拒绝空地址', !allowed(''))

  // ③ D1/D2：二维码输入校验
  const { encodeQr, qrToSvg } = await import('../lib/qr.js')
  const throws = (fn) => { try { fn(); return false } catch (err) { return true } }
  check('version=41 被拒（原先越界 TypeError）', throws(() => encodeQr('hi', { version: 41 })))
  check('version=0 被拒（原先报"内容太长"误导）', throws(() => encodeQr('hi', { version: 0 })))
  check('容量不足被拒（原先静默丢数据）', throws(() => encodeQr('A'.repeat(100), { version: 1 })))
  const mods = encodeQr('hi').modules
  check('颜色注入被拒（SVG 属性）', throws(() => qrToSvg(mods, { dark: '"/><script>alert(1)</script>' })))
  check('非法 scale 被拒（原先产出 NaN）', throws(() => qrToSvg(mods, { scale: '4" onload="' })))
  check('负 margin 被夹到 0（不裁图）', qrToSvg(mods, { scale: 4, margin: -5 }).includes('width="84"'))

  // ④ D4：@ 清洗
  const { cleanAt } = await import('../lib/bili-api.js')
  check('@ 前缀被去掉', cleanAt('@@某某') === '某某')
  check('@ 里的换行/控制字符被清掉', !/[\n\r\u0007]/u.test(cleanAt('张三\u0007\n李四')))
  check('@ 超长截断到 30 字', cleanAt('A'.repeat(80)).length === 30)

  // ⑤ S3 + S11：配置校验走真实路由
  const unc = await callRoute('/bili-duty/config.json', {
    method: 'POST',
    body: JSON.stringify({ workspace: '\\\\evil-host\\share' }),
  })
  check('UNC workspace 被 400 拒绝', unc.status === 400, unc.data)
  const rel = await callRoute('/bili-duty/config.json', {
    method: 'POST',
    body: JSON.stringify({ workspace: 'relative/path' }),
  })
  check('相对路径 workspace 被 400 拒绝', rel.status === 400, rel.data)
  const peak = await callRoute('/bili-duty/config.json', {
    method: 'POST',
    body: JSON.stringify({ peak_windows: ['99:99-00:00', '09:00-12:00'] }),
  })
  check('非法峰时窗口被过滤（99:99-00:00）', peak.status === 200 && !peak.data.config.peak_windows.includes('99:99-00:00'), peak.data.config?.peak_windows)
  check('合法峰时窗口保留（09:00-12:00）', Array.isArray(peak.data.config?.peak_windows) && peak.data.config.peak_windows.includes('09:00-12:00'))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败  （临时目录 ${TMP}）`)
if (fail === 0) {
  fs.rmSync(TMP, { recursive: true, force: true })
  console.log('临时目录已清理')
} else {
  console.log('有失败项，临时目录保留供排查')
}
process.exit(fail === 0 ? 0 : 1)
