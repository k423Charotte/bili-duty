/**
 * B站扫码登录 + 凭证管理（纯 fetch，零依赖）。
 * ============================================================================
 * 为什么要有这一层：发评论、读官方 AI 字幕、读需要登录的内容，全都要登录态。
 * 而**复用浏览器登录态是不可能的**（Chrome 用 v20 App-Bound 加密，DPAPI 解不开，实测过），
 * 所以只能让插件自己扫码、自己持有凭证（凭证只落本机插件家目录，不上传任何地方）。
 *
 * 端点与流程来自 B站 官方 passport 接口（对照 dsh-bili-scroll 的 lib/login.mjs 验证过同一套）：
 *   GET  /x/passport-login/web/qrcode/generate   → data.url + data.qrcode_key
 *   GET  /x/passport-login/web/qrcode/poll       → data.code：0 成功 / 86101 未扫 / 86090 已扫 / 86038 过期
 *   ⚠️ **凭证在响应的 Set-Cookie 头里，不在 body 里** —— 这是最容易踩空的一点。
 *   GET  /x/frontend/finger/spi                  → buvid3（客户端指纹，缺了有些接口会风控）
 */

import dns from 'node:dns'

/**
 * ⚠️ 为什么需要它（2026-10-16 实测踩过）：
 * Node 的 fetch(undici) 会**优先使用 IPv6**，而 `api.bilibili.com` 确实有 AAAA 记录
 * （实测 `dns.lookup` 返回的第一个就是 `2409:8c3c:4:2::74`）。本机走 IPv6 到 B站 不通/不稳时，
 * 表现就是一句光秃秃的 `fetch failed`。
 *
 * 阴险之处：系统 node 有时能侥幸回退到 IPv4，所以在命令行里测**是通的**，
 * 一放进 Electron 宿主就失败 —— 极难查。改成 IPv4 优先即可。
 * （whale-widget 也踩过同一个坑，它的注释里记的就是这个。）
 *
 * ⚠️ 安全修正（2026-10-16 安全审查）：`dns.setDefaultResultOrder` 是**进程级**设置，
 * 原本写在模块顶层 —— 只要 import 本模块，整个 DSH 宿主与其它插件的 DNS 解析顺序都被改掉。
 * 现在改成「第一次真正要发 B站 请求时才设置一次」，副作用范围收窄。
 */
let ipv4FirstApplied = false
function ensureIpv4First() {
  if (ipv4FirstApplied) return
  ipv4FirstApplied = true
  try {
    dns.setDefaultResultOrder('ipv4first')
  } catch (err) {
    /* 老版本 Node 没有这个 API，忽略即可 */
  }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/120.0.0.0 Safari/537.36'
/** 浏览器 UA 对外导出：字幕之类的资源在别的域名（aisubtitle.hdslb.com）上，需要同样的头。 */
export const BILI_UA = UA
const PASSPORT = 'https://passport.bilibili.com'
const API = 'https://api.bilibili.com'
const TIMEOUT_MS = 15000
/** 单次响应体读取上限（字幕 JSON 正常几百 KB；超了就是异常，别把宿主内存吃光）。 */
const MAX_RESOURCE_BYTES = 2 * 1024 * 1024

/**
 * 允许**带凭证**访问的主机后缀（B 站自家域）。
 *
 * ⚠️ 这条白名单是安全审查 S1 的修复：`subtitle_url` 完全来自接口响应，
 * 原实现不校验主机/协议就附上完整 Cookie（SESSDATA + bili_jct），
 * 于是"接口说去哪就去哪"——响应一旦被污染，凭证就被发到任意主机（含明文 http）。
 * 实测复现见 `_refs/poc-subtitle-cookie-leak.mjs`。
 */
const TRUSTED_HOST_SUFFIXES = ['hdslb.com', 'bilibili.com', 'bilivideo.com']

/**
 * 校验一个"要用凭证去请求"的绝对地址：必须合法、必须 https、必须落在 B 站自家域。
 * @param {string} url
 * @returns {URL} 解析后的 URL
 */
export function assertTrustedHttpsUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') {
    throw new Error('资源地址为空（接口没给出 subtitle_url）——已跳过，不发任何带凭证的请求')
  }
  let parsed
  try {
    parsed = new URL(url)
  } catch (err) {
    throw new Error(`资源地址不是合法 URL：${url.slice(0, 120)}`)
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`拒绝非 https 的资源地址（${parsed.protocol}//${parsed.hostname}）——凭证不能走明文`)
  }
  const host = parsed.hostname.toLowerCase()
  const ok = TRUSTED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
  if (!ok) {
    throw new Error(`资源地址不在白名单（只允许 B 站自家域）：${host}`)
  }
  return parsed
}

/** 读取响应体，带字节上限（超限就截断并停止继续拉流）。 */
async function readBodyLimited(response, maxBytes = MAX_RESOURCE_BYTES) {
  const reader = typeof response.body?.getReader === 'function' ? response.body.getReader() : null
  if (!reader) {
    const text = await response.text()
    return text.length > maxBytes ? text.slice(0, maxBytes) : text
  }
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const size = value?.byteLength ?? 0
    if (total + size > maxBytes) {
      chunks.push(Buffer.from(value).subarray(0, Math.max(0, maxBytes - total)))
      total = maxBytes
      try { await reader.cancel() } catch (err) { /* 取不到就算了，已经不需要了 */ }
      break
    }
    chunks.push(Buffer.from(value))
    total += size
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** data.code → 人类可读状态 */
const POLL_STATUS = {
  0: 'success',
  86101: 'waiting',
  86090: 'scanned',
  86038: 'expired',
}

function requestHeaders(extra = {}) {
  return {
    'User-Agent': UA,
    Referer: 'https://www.bilibili.com/',
    Origin: 'https://www.bilibili.com',
    ...extra,
  }
}

/** 把 undici 那句光秃秃的 `fetch failed` 还原成人能看懂的原因（cause 里才有真东西）。 */
function describeFetchError(err) {
  const cause = err?.cause
  const code = cause?.code ?? cause?.name ?? ''
  const message = cause?.message ?? ''
  const detail = [code, message].filter(Boolean).join(' ').trim()
  return detail ? `${err.message}（${detail}）` : String(err?.message ?? err)
}

/**
 * 带一次重试的 fetch。网络抖动 / IPv6 回退不及时都可能让第一次失败，
 * 而这类调用（工具、路由）重试一次几乎不花时间，比让使用者看到"失败"划算。
 */
async function fetchWithRetry(url, options = {}, attempt = 0) {
  ensureIpv4First()
  // ⚠️ 安全审查 D7：只有幂等方法才重试。POST 超时后重试＝重复提交，
  // 而这里唯一的 POST 是"用真人账号发评论"——重复一次就是重复评论。
  const method = String(options.method || 'GET').toUpperCase()
  const retryable = method === 'GET' || method === 'HEAD'
  try {
    return await fetch(url, {
      ...options,
      headers: requestHeaders(options.headers),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    if (attempt === 0 && retryable) {
      await new Promise((resolve) => { setTimeout(resolve, 400) })
      return fetchWithRetry(url, options, 1)
    }
    // ⚠️ 安全审查 D8：catch 里的 `new URL()` 自己也会抛（空串/非法地址），
    // 必须包起来，否则真实失败原因被 "TypeError: Invalid URL" 掩盖。
    let host = String(url)
    try { host = new URL(url).host } catch (parseErr) { /* 地址本身就不合法：原样显示 */ }
    throw new Error(`请求 ${host} 失败：${describeFetchError(err)}`)
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetchWithRetry(url, options)
  let body = null
  try {
    body = await response.json()
  } catch (err) {
    throw new Error(`接口返回的不是 JSON（HTTP ${response.status}）`)
  }
  return { response, body }
}

/** 申请一个登录二维码。 */
export async function loginStart() {
  const { body } = await fetchJson(`${PASSPORT}/x/passport-login/web/qrcode/generate?source=main-fe-header`)
  if (body?.code !== 0 || !body?.data?.url || !body?.data?.qrcode_key) {
    throw new Error(`申请二维码失败：code=${body?.code} message=${body?.message ?? '未知'}`)
  }
  const url = String(body.data.url)
  // ⚠️ 安全审查 D3：这张码是给用户手机扫的。响应若被篡改，未校验主机会把用户引到钓鱼站
  // （手机上点「确认登录」＝交出凭证）。强制 https + B 站自家域，否则拒绝展示。
  assertTrustedHttpsUrl(url)
  return { url, qrcodeKey: String(body.data.qrcode_key) }
}

/** 从 Set-Cookie 里抠出四个关键字段（凭证就在这儿，不在 body）。 */
function extractCredential(setCookies) {
  // 键名来自服务端 Set-Cookie —— 用无原型对象，避免 __proto__ 这类键污染（安全审查 D10）
  const jar = Object.create(null)
  for (const line of setCookies) {
    const pair = String(line).split(';')[0]
    const index = pair.indexOf('=')
    if (index <= 0) continue
    jar[pair.slice(0, index).trim()] = pair.slice(index + 1).trim()
  }
  return {
    sessdata: jar.SESSDATA ?? '',
    biliJct: jar.bili_jct ?? '',
    buvid3: jar.buvid3 ?? '',
    dedeUserId: jar.DedeUserID ?? '',
  }
}

async function fetchBuvid3() {
  try {
    const { body } = await fetchJson(`${API}/x/frontend/finger/spi`)
    return String(body?.data?.b_3 ?? '')
  } catch (err) {
    return ''
  }
}

/**
 * 查一次扫码结果。
 * @returns {{status: 'waiting'|'scanned'|'expired'|'success'|'unknown', code: number, message: string,
 *            credential?: {sessdata: string, biliJct: string, buvid3: string, dedeUserId: string}}}
 */
export async function loginPoll(qrcodeKey) {
  const url = `${PASSPORT}/x/passport-login/web/qrcode/poll`
    + `?qrcode_key=${encodeURIComponent(qrcodeKey)}&source=main-fe-header`
  const { response, body } = await fetchJson(url, { redirect: 'manual' })

  const code = Number(body?.data?.code ?? -1)
  const status = POLL_STATUS[code] ?? 'unknown'
  const message = String(body?.data?.message ?? body?.message ?? '')

  if (status !== 'success') return { status, code, message }

  // 成功：凭证在 Set-Cookie 头里
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : []
  const credential = extractCredential(setCookies)
  if (!credential.sessdata) {
    return { status: 'unknown', code, message: '登录接口返回成功，但没拿到 SESSDATA（凭证解析失败）' }
  }
  if (!credential.buvid3) credential.buvid3 = await fetchBuvid3()
  return { status, code, message, credential }
}

/** 凭证 → Cookie 请求头。 */
export function cookieHeader(credential) {
  if (!credential) return ''
  const jar = [
    ['SESSDATA', credential.sessdata],
    ['bili_jct', credential.biliJct],
    ['buvid3', credential.buvid3],
    ['DedeUserID', credential.dedeUserId],
  ]
  return jar.filter(([, value]) => value).map(([name, value]) => `${name}=${value}`).join('; ')
}

/** 查当前登录身份（用来验证凭证真的能用，而不是"看起来存下来了"）。 */
export async function whoami(credential) {
  if (!credential?.sessdata) return { loggedIn: false, reason: '没有凭证' }
  const { body } = await fetchJson(`${API}/x/web-interface/nav`, {
    headers: { Cookie: cookieHeader(credential) },
  })
  const data = body?.data ?? {}
  return {
    loggedIn: body?.code === 0 && data.isLogin === true,
    mid: data.mid ?? null,
    uname: String(data.uname ?? ''),
    vip: data.vipStatus === 1,
    code: body?.code ?? null,
    message: String(body?.message ?? ''),
  }
}

/**
 * 带登录态请求 B站 Web API（数据通道工具共用）。
 * 会自动带上 Cookie 与 Referer，并把非 JSON/网络错误转成可读异常。
 */
export async function biliApi(pathname, credential, options = {}) {
  const headers = { ...(options.headers || {}) }
  const cookie = cookieHeader(credential)
  if (cookie) headers.Cookie = cookie
  const { body, response } = await fetchJson(`${API}${pathname}`, { ...options, headers })
  return { body, status: response.status }
}

/**
 * 请求任意绝对地址 —— 字幕资源不在 api.bilibili.com 上（在 `aisubtitle.hdslb.com`），
 * 所以不能复用 biliApi 的拼接。同样带浏览器头与凭证。
 */
export async function biliGetAbsolute(url, credential, options = {}) {
  // ⚠️ 安全审查 S1（唯一高危）：这个地址来自接口响应，原实现不校验主机/协议就附上完整 Cookie ——
  // 响应一旦被污染，SESSDATA / bili_jct 就被发到任意主机（含明文 http）。本地复现见
  // `_refs/poc-subtitle-cookie-leak.mjs`。现在：必须 https，且必须落在 B 站自家域。
  const target = assertTrustedHttpsUrl(url)
  const cookie = cookieHeader(credential)
  // 走同一套"IPv4 优先 + 重试 + 可读错误"的通道：字幕在 aisubtitle.hdslb.com 上，同样有 IPv6 坑。
  const response = await fetchWithRetry(target.href, {
    ...options,
    redirect: 'follow',
    headers: { ...(options.headers || {}), ...(cookie ? { Cookie: cookie } : {}) },
  })
  // 跟随后再校验一次最终落点：不允许重定向把凭证带到白名单之外（纵深防御 ——
  // 实测 undici 对跨源重定向会剥掉手工 Cookie，但这条不依赖它的实现细节）。
  try {
    assertTrustedHttpsUrl(response.url || target.href)
  } catch (err) {
    throw new Error(`资源地址重定向到了白名单之外，已丢弃响应：${String(response.url || '').slice(0, 120)}`)
  }
  const text = await readBodyLimited(response)
  let body = null
  try {
    body = JSON.parse(text)
  } catch (err) {
    body = { _raw: text.slice(0, 300) }
  }
  return { body, status: response.status }
}
