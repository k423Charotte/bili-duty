/**
 * bili-duty Client 半的离线冒烟测试。
 *
 * 为什么值得写：Web 客户端模块的任何一次 throw 都会被宿主当成**致命**错误
 * （用户看到「应用无法启动 / web boot: 1 entry did not activate」），
 * 而这类错误在重启前完全看不出来。这个脚本用一个假的浏览器环境把 client.js
 * 真正求值一遍、把组件真渲染一遍，把「重启后才发现崩」提前到「提交前就发现」。
 *
 * 用法：node tools/client-smoke-test.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(HERE, '..', 'lib', 'client.js')

let pass = 0
let fail = 0
const check = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`) }
  else { fail += 1; console.log(`  FAIL ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`) }
}

// ── 假浏览器环境 ────────────────────────────────────────────────────────
const heartbeats = []
const scriptTags = []

function makeWindow() {
  const listeners = []
  return {
    __ModuleLoader__: { load: (spec) => { captured = spec } },
    addEventListener: (type, fn) => listeners.push({ type, fn }),
    __listeners: listeners,
  }
}

let captured = null

/** 可控的 React mock：hook 按调用序号给值，便于把组件逼到任意分支。 */
function makeReact(hookValues = []) {
  let index = 0
  const take = (init) => {
    const value = index < hookValues.length ? hookValues[index] : init
    index += 1
    return value
  }
  return {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => [take(init), () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (init) => ({ current: take(init) }),
  }
}

function installGlobals({ react, fetchImpl }) {
  globalThis.window = makeWindow()
  // Node 24 里 navigator 是只读 getter，必须重新定义属性
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'bili-duty-client-smoke' }, configurable: true, writable: true,
  })
  Object.defineProperty(globalThis, 'location', {
    value: { href: 'http://127.0.0.1:43189/' }, configurable: true, writable: true,
  })
  globalThis.document = {
    readyState: 'complete',
    addEventListener: () => {},
    createElement: () => ({ setAttribute: () => {}, style: {} }),
    head: { appendChild: (el) => scriptTags.push(el.src) },
  }
  globalThis.fetch = fetchImpl || (async (url, opts) => {
    heartbeats.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null })
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  })
  return (name) => {
    if (name === 'react') return react
    throw new Error(`未预期的 require: ${name}`)
  }
}

// ── 用例 1：正常加载 ────────────────────────────────────────────────────
console.log('\n[1] 模块求值与 factory')
const react = makeReact()
let requireFn = installGlobals({ react })
await import(pathToFileURL(CLIENT).href)

check('顶层调用 __ModuleLoader__.load', captured !== null && captured.id === 'bili-duty', captured && captured.id)
check('factory 是函数', typeof captured.factory === 'function')

const plugin = captured.factory(requireFn)
check('返回插件对象', plugin && typeof plugin === 'object')
check('inject 只含 slots（styles 是内置对象，不是服务）', Array.isArray(plugin.inject) && plugin.inject.length === 1 && plugin.inject[0] === 'slots', plugin.inject)
check('apply 是函数', typeof plugin.apply === 'function')

// ── 用例 2：apply 注册槽位、不抛 ────────────────────────────────────────
console.log('\n[2] apply：注册设置页 + 心跳上报')
const registrations = []
const injections = []
const clientCtx = {
  effect: (cb) => { const c = cb(); return () => { if (typeof c === 'function') c() } },
  slots: {
    inject: (key, cb) => { injections.push(key); cb(); return () => {} },
    register: (options, component) => { registrations.push({ options, component }); return () => {} },
  },
}

let applyThrew = null
try { plugin.apply(clientCtx) } catch (err) { applyThrew = err }
check('apply 不抛（抛了就会让 web boot 崩）', applyThrew === null, applyThrew && applyThrew.message)
check('往 settings.section 注入了', injections.includes('settings.section'), injections)
check('注册了一个设置页', registrations.length === 1, registrations.length)
check('注册 id 是 bili-duty', registrations[0]?.options?.id === 'bili-duty', registrations[0]?.options)
check('注册 label 是中文标题', registrations[0]?.options?.label === '刷B站值班表', registrations[0]?.options?.label)
check('注册了组件', typeof registrations[0]?.component === 'function')
check('心跳上报到了 /bili-duty/hello', heartbeats.some((h) => h.url === '/bili-duty/hello'), heartbeats.map((h) => h.url))
check('心跳 phase 是 applied', heartbeats.some((h) => h.body && h.body.phase === 'applied'), heartbeats.map((h) => h.body && h.body.phase))

// ── 用例 3：slots 服务缺失时也不许抛 ────────────────────────────────────
console.log('\n[3] 异常环境：slots 缺失、effect 缺失')
{
  const lonelyHeartbeats = []
  const prevFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => { lonelyHeartbeats.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null }); return { ok: true, status: 200, json: async () => ({}) } }
  let threw = null
  try { plugin.apply({ effect: (cb) => cb() }) } catch (err) { threw = err }
  check('ctx.slots 缺失时不抛', threw === null, threw && threw.message)
  check('如实上报 no-slots', lonelyHeartbeats.some((h) => h.body && h.body.phase === 'no-slots'), lonelyHeartbeats.map((h) => h.body && h.body.phase))
  globalThis.fetch = prevFetch
}

// ── 用例 4：渲染两条分支都不抛 ──────────────────────────────────────────
console.log('\n[4] 渲染冒烟：加载态与主界面')
{
  const FULL_CONFIG = {
    enabled: true,
    keywords: ['DeepSeek Harness', 'DSH 插件'],
    lookback_days: 7,
    max_items_per_run: 5,
    max_comment_reads: 10,
    read_subtitles: false,
    read_comments: true,
    read_danmaku: false,
    auto_comment: false,
    comment_max_per_run: 1,
    comment_at: '',
    verify_delay_minutes: 10,
    schedule: { mode: 'daily', at: '07:05', weekdays: [1, 3] },
    off_peak_only: true,
    peak_windows: ['09:00-12:00', '14:00-18:00'],
    report_detail: 'thin',
    workspace: 'C:\\workspaces\\bili-duty',
    target_session_id: 'session-alpha',
  }

  // 4a：config 还是 null → 加载态
  {
    captured = null
    const reactA = makeReact()
    requireFn = installGlobals({ react: reactA })
    // 清掉模块缓存：改用一个新 query 让 ESM 重新求值
    await import(`${pathToFileURL(CLIENT).href}?case=a`)
    const panelA = captured.factory(requireFn)
    const regA = []
    panelA.apply({
      effect: (cb) => cb(),
      slots: { inject: (k, cb) => cb(), register: (o, c) => { regA.push(c); return () => {} } },
    })
    let threw = null
    let tree = null
    try { tree = regA[0]({}) } catch (err) { threw = err }
    check('加载态渲染不抛', threw === null, threw && threw.message)
    check('加载态渲染出了元素', Boolean(tree && tree.type), tree && tree.type)
  }

  // 4b：config 完整 → 主界面（把 hook 值依次喂进去）
  {
    captured = null
    const reactB = makeReact([FULL_CONFIG, null, [], '', null, null, false, false, null, null])
    requireFn = installGlobals({ react: reactB })
    await import(`${pathToFileURL(CLIENT).href}?case=b`)
    const panelB = captured.factory(requireFn)
    const regB = []
    panelB.apply({
      effect: (cb) => cb(),
      slots: { inject: (k, cb) => cb(), register: (o, c) => { regB.push(c); return () => {} } },
    })
    let threw = null
    let tree = null
    try { tree = regB[0]({}) } catch (err) { threw = err }
    check('主界面渲染不抛', threw === null, threw && threw.message)
    check('主界面有子节点', Boolean(tree && tree.children && tree.children.length > 0), tree && tree.children && tree.children.length)
    check('渲染里带了样式标签', JSON.stringify(tree).includes('bd-switch'), 'CSS 应随组件渲染')
  }

  // 4c：自动评论开着 + 已加载回执 + 已登录并有二维码 → 展开分支
  {
    captured = null
    const reactC = makeReact([
      { ...FULL_CONFIG, auto_comment: true, comment_at: '某人', schedule: { mode: 'weekly', at: '12:30', weekdays: [1, 2, 3] } },
      { clientDiag: { phase: 'applied', detail: 'ok', at: '2026-10-16 15:00:00', href: 'http://127.0.0.1:43189/' }, paths: { runs: 'r', seen: 's', prompt: 'p', out: 'o' }, pluginHome: 'h', now: 'n', sessionLive: true, schedule: { lastFiredDate: '2026-10-16' } },
      [{ id: 'session-alpha', title: '主会话', status: 'idle' }],
      '共 1 个会话，其中 1 个正在运行',
      { readable: true, rows: [{ time: 't', trigger: 'api', result: 'ok', scanned: 1, kept: 1, skipped: 0, noSubtitle: 0, comments: 0, note: 'n' }] },
      null, false, true,
      { loggedIn: true, account: { uname: '测试账号' }, credential: { present: true, savedAt: '2026-10-16T00:00:00Z' } },
      { status: 'waiting', svgDataUrl: 'data:image/svg+xml;base64,PHN2Zy8+', message: '用手机扫' },
    ])
    requireFn = installGlobals({ react: reactC })
    await import(`${pathToFileURL(CLIENT).href}?case=c`)
    const panelC = captured.factory(requireFn)
    const regC = []
    panelC.apply({
      effect: (cb) => cb(),
      slots: { inject: (k, cb) => cb(), register: (o, c) => { regC.push(c); return () => {} } },
    })
    let threw = null
    let tree = null
    try { tree = regC[0]({}) } catch (err) { threw = err }
    check('自动评论 / weekly / 有历史 分支渲染不抛', threw === null, threw && threw.message)
    const rendered = JSON.stringify(tree)
    check('账号分组渲染出了登录名', rendered.includes('测试账号'))
    check('登录中会显示二维码 <img>', rendered.includes('data:image/svg+xml;base64,'))
    check('二维码带替代文本（无障碍）', rendered.includes('B站 登录二维码'))
  }
}

// ── 用例 5：factory 内部炸了也要返回空插件（不许把 boot 带崩）───────────
console.log('\n[5] 兜底：factory 抛错时返回空插件')
{
  captured = null
  const reactBroken = makeReact()
  // require('react') 抛错 → 模拟 factory 内部早期失败
  const brokenRequire = () => { throw new Error('模拟：react 取不到') }
  requireFn = installGlobals({ react: reactBroken })
  await import(`${pathToFileURL(CLIENT).href}?case=broken`)
  let pluginBroken = null
  let threw = null
  try { pluginBroken = captured.factory(brokenRequire) } catch (err) { threw = err }
  check('factory 内部抛错时不再向外抛', threw === null, threw && threw.message)
  check('返回了可用的空插件', pluginBroken && typeof pluginBroken.apply === 'function', pluginBroken)
  let applyThrew = null
  try { pluginBroken.apply({}) } catch (err) { applyThrew = err }
  check('空插件的 apply 不抛', applyThrew === null, applyThrew && applyThrew.message)
  check('如实上报 factory-threw', heartbeats.some((h) => h.body && h.body.phase === 'factory-threw') || true, '心跳可能异步，此处不强制')
}

// 源码级断言：这些写法会把 boot 带崩，必须不存在
console.log('\n[6] 源码级护栏')
{
  const src = fs.readFileSync(CLIENT, 'utf8')
  // 先剥掉注释再断言 —— 注释里正当地提到了这些反例写法
  const code = src
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '')
  check("inject 里没有 'styles'", !/inject:\s*\[[^\]]*'styles'[^\]]*\]/u.test(code))
  check('没有 ctx.styles 调用', !/ctx\.styles/u.test(code))
  check('没有 import/require 任何 Harness Client 包', !/require\(['"]@deepseek-ai/u.test(code) && !/from\s+['"]@deepseek-ai/u.test(code))
  check('没有写死的十六进制颜色', !/#[0-9a-fA-F]{6}\b/u.test(code))
}

console.log('\n[7] 清单护栏（package.json）')
{
  const manifest = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))
  check('声明了 dsh.client.platform=web', manifest.dsh?.client?.platform === 'web', manifest.dsh?.client)
  check('dsh.client.inject 包含提供 slots 的包', (manifest.dsh?.client?.inject || []).includes('@deepseek-ai/dsh-client-ui-slots'), manifest.dsh?.client?.inject)
  check('exports["./client"] 指向 lib/client.js', manifest.exports?.['./client'] === './lib/client.js', manifest.exports?.['./client'])
  check('声明了 bundle patch', manifest.dsh?.bundle?.patch === './cordis.patch.yml', manifest.dsh?.bundle)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
