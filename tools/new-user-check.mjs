/**
 * bili-duty · 新用户旅程验收（离线、零依赖、不碰真实数据）
 * ============================================================================
 * 模拟「一个从没见过这个项目的人」装完之后的第一天：
 *   能不能加载 → 默认值对不对 → 会不会碰他的账号 → 失败时看不看得懂 → 文件落在哪
 *
 * ⚠️ 刻意**不** stub `@deepseek-ai/dsh-llm`：真实用户的机器上通常也没有这个包，
 *    正好用来验证「宿主不提供它时插件仍能加载」这条跨版本兜底（lib/index.js 的动态 import + 兜底）。
 *
 * 用法：node tools/new-user-check.mjs      （或 npm run check:new-user）
 * 不连 DSH、不发任何网络请求、所有写入都落在系统临时目录里。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── 隔离：改写 DSH_HOME 到临时目录（必须在 import 插件之前）────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-duty-newuser-'))
process.env.DSH_HOME = TMP
const HOME_DIR = path.join(TMP, 'bili-duty')
const WORKSPACE = path.join(TMP, 'workspace')
fs.mkdirSync(WORKSPACE, { recursive: true })

let pass = 0
let fail = 0
const check = (name, cond, detail) => {
  if (cond) {
    pass += 1
    console.log(`  ok   ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail).slice(0, 300)}`}`)
  }
}

// ── 最小假 ctx：**故意不给 webServer**（验证"可选依赖缺失只降级、不阻塞"）──
const registeredTools = []
const ctx = {
  get: (name) => {
    if (name === 'tools') return { register: (spec) => { registeredTools.push(spec); return () => {} } }
    if (name === 'agents') return { get: () => undefined, list: () => [] }   // 此刻没有任何会话在跑
    if (name === 'timer') return { timeout: ctx.timeout, interval: ctx.interval }
    return undefined                                                          // webServer / sessionQuery … 都没有
  },
  interval: () => () => {},
  timeout: () => () => {},
  effect: (cb) => { const cleanup = cb(); return () => { if (typeof cleanup === 'function') cleanup() } },
  logger: () => () => {},
}

const tool = (name) => {
  const found = registeredTools.find((t) => t.name === name)
  if (!found) throw new Error(`工具没注册：${name}`)
  return found
}

console.log(`\n新用户旅程验收（临时家目录 ${TMP}）`)

console.log('\n[1] 能不能加载（宿主不提供 @deepseek-ai/dsh-llm）')
let mod = null
try {
  mod = await import('../lib/index.js')
} catch (err) {
  check('模块可加载', false, String(err?.message || err))
}
check('模块可加载（缺 dsh-llm 也不失败）', Boolean(mod) && typeof mod.apply === 'function')
check('inject 只声明真实服务 timer/tools', JSON.stringify(mod.inject) === '["timer","tools"]', mod.inject)

console.log('\n[2] apply：没有 webServer 也必须活着')
let applyThrew = null
try {
  mod.apply(ctx, {})
} catch (err) {
  applyThrew = String(err?.message || err)
}
check('apply 没有抛错（可选依赖缺失只降级）', applyThrew === null, applyThrew)
check('注册了 13 个工具', registeredTools.length === 13, registeredTools.map((t) => t.name))
check('工具名都带 bili_duty_ 前缀', registeredTools.every((t) => t.name.startsWith('bili_duty_')))

console.log('\n[3] 新用户看到的默认值')
const info = await tool('bili_duty_info').execute({}, {})
check('总开关默认开着', info.enabled === true, info.enabled)
check('关键词回落到内置示例（3 条，可改）', Array.isArray(info.keywords) && info.keywords.length === 3, info.keywords)
check('自动评论默认关着（不碰他的账号）', info.auto_comment === false, info.auto_comment)
check('目标会话默认空（必须先选，不猜）', info.target_session_id === '', info.target_session_id)
check('读字幕默认开（登录后是判断主依据）', info.read_subtitles === true)
check('读评论默认开', info.read_comments === true)
check('报告默认写完整版', info.report_detail === 'full', info.report_detail)

console.log('\n[4] 文件落在哪（不许写到别处）')
const writable = [info.paths?.dir, info.paths?.runs, info.paths?.seen, info.paths?.out]
check('可写数据（配置 / 记录 / 报告）全在 DSH_HOME 之下',
  writable.every((p) => typeof p === 'string' && p.startsWith(TMP)), writable)
check('准则文件来自插件包（只读资源，不写数据目录）',
  typeof info.paths?.prompt === 'string' && info.paths.prompt.includes('prompts'), info.paths?.prompt)
check('凭证路径也在 DSH_HOME 之下',
  typeof info.credentialFile === 'string' && info.credentialFile.startsWith(TMP), info.credentialFile)
check('家目录已建好', fs.existsSync(HOME_DIR), HOME_DIR)
check('首次启动**不创建**凭证文件', !fs.existsSync(path.join(HOME_DIR, 'bili_credential.json')))
check('没登录时如实报告未登录', info.credentialPresent === false, info.credentialPresent)

console.log('\n[5] 失败时看不看得懂 + 会不会碰账号')
const sent = await tool('bili_duty_comment_send').execute({ bv: 'BV1xx411c7mD', text: '这是一条不该发出去的测试评论' }, {})
check('没开自动评论时，发评论被拒（代码强制）', sent.ok === false, sent)
check('拒绝码明确（不是一句黑话）', sent.code === 'AUTO_COMMENT_OFF', sent.code)
check('拒绝理由是人话', typeof sent.error === 'string' && sent.error.includes('账号'), sent.error)
const runsFile = path.join(HOME_DIR, 'runs.md')
check('被拒也写进了执行记录（失败不静默）',
  fs.existsSync(runsFile) && fs.readFileSync(runsFile, 'utf8').includes('AUTO_COMMENT_OFF'))

console.log('\n[6] 判重表还不存在时的行为（铁律相关）')
const seen = await tool('bili_duty_seen_query').execute({ bv: 'BV1xx411c7mD' }, {})
check('查询不抛错', typeof seen === 'object' && seen !== null, seen)
check('明确回答"读得到/读不到"，不含糊', typeof seen.readable === 'boolean', seen)
if (seen.readable === false) {
  check('读不到时给了理由与铁律（不许当成没记录过）', Boolean(seen.error || seen.rule), seen)
}

console.log('\n[7] 记录文件写在正确位置')
const added = await tool('bili_duty_run_add').execute({
  trigger: 'manual', result: 'ok', scanned: 0, kept: 0, skipped: 0, no_subtitle: 0, comments: 0,
  note: '新用户旅程验收',
}, {})
check('执行记录写入成功', added.ok === true, added)
check('写的是 DSH_HOME 下的 runs.md', fs.readFileSync(runsFile, 'utf8').includes('新用户旅程验收'))

// ── 收尾 ─────────────────────────────────────────────────────────────────
fs.rmSync(TMP, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
console.log(fail === 0
  ? '新用户旅程：全部通过（临时目录已清理）'
  : '有失败项 —— 新用户会在这一步卡住，先修它')
process.exit(fail === 0 ? 0 : 1)
