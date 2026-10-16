/**
 * B站数据通道（读内容 + 发评论）—— 全部走官方 Web 接口，纯 fetch。
 * ============================================================================
 * 这一层是本项目 2026-10-16 最重要的一次能力修正：
 *   带着**登录态**重新实测，当初两条"通道不可用"的结论全被推翻 ——
 *     · 字幕：`x/player/wbi/v2` 返回 6 条轨（中/英/日/西/阿/葡），样本拿到 397 条字幕正文；
 *     · 搜索：`x/web-interface/search/type` 直接 code=0 返回结果（当初的 412 是未登录被风控）。
 *   所以"值不值得看"终于可以按**字幕原文**判断，而不是退化到标题+简介。
 *
 * ⚠️ 发评论（`sendComment`）已实测成功过一次（2026-10-16 16:27，用户授权，rpid 320875489632）——
 *    但**公开可见性仍未确认**：B站评论计数有 5–10 分钟延迟，且热门排序看不到低赞评论，
 *    必须延迟复核（`bili_duty_verify_in`）+ 按时间排序核对（`videoComments` 的 `order: 'time'`）。
 *    端点与参数来自官方接口（`x/v2/reply/add` + csrf=bili_jct）。
 */

import { biliApi, biliGetAbsolute, cookieHeader, BILI_UA, assertTrustedHttpsUrl } from './bili-login.js'

/** 搜索结果标题里带 <em class="keyword"> 高亮标签，要剥掉。 */
function stripHtml(text) {
  return String(text ?? '').replace(/<[^>]*>/gu, '').replace(/&quot;/gu, '"').replace(/&amp;/gu, '&').trim()
}

/**
 * @ 对象清洗（安全审查 D4）：去 @ 前缀、去换行与控制字符、限 30 字。
 * 昵称允许内部空格（B 站昵称本来就有），所以只折叠空白、不整段删除。
 * （导出是为了让离线 smoke-test 能直接验证这段逻辑。）
 */
export function cleanAt(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^@+/u, '')
    .slice(0, 30)
    .trim()
}

/** 服务端 message 是不可信文本，进错误/记录前先截断（安全审查 D11）。 */
function brief(value, max = 200) {
  return String(value ?? '').replace(/\s+/gu, ' ').slice(0, max)
}

/**
 * 把可能含**孤立代理项**（lone surrogate）的文本修成 well-formed。
 *
 * 为什么必须有（2026-10-16 值班实测踩到）：B 站字幕正文里混进过孤立代理项，
 * `JSON.stringify` 会产出无效字符串，DSH 工具层直接以
 * `value is not lossless JSON` **拒绝整包返回** —— 一个脏字符毁掉整次调用。
 */
export function toWellFormedText(value) {
  const text = String(value ?? '')
  if (typeof text.toWellFormed === 'function') return text.toWellFormed()
  // 老 Node 的兜底：把落单的代理项换成替换字符
  return text
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/gu, '\uFFFD')
    .replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/gu, '$1\uFFFD')
}

/**
 * 选字幕轨（2026-10-16 值班发现后重写）。
 *
 * 旧逻辑：传了 `lan` 未命中就直接 `tracks[0]`，不传就 `ai-zh` 优先 —— 等于**最信任 AI 轨**。
 * 实测教训：B 站的 `ai-zh` 轨**不保证是这个视频的字幕**（遇到两条视频的 ai-zh 内容是别的视频，
 * 而同一条视频的人工轨 `zh-Hans` 才是对的）。所以顺序改为：
 *   ① 精确匹配请求的 lan → ② 人工中文轨（zh-Hans/zh-CN…，排除 ai-*）→ ③ ai-zh → ④ 第一条
 */
function pickTrack(tracks, lan) {
  if (lan) {
    const exact = tracks.find((track) => track.lan === lan)
    if (exact) return exact
  }
  const manualZh = tracks.find((track) => /^zh(-|_|$)/iu.test(track.lan) && !/^ai-/iu.test(track.lan))
  if (manualZh) return manualZh
  const aiZh = tracks.find((track) => track.lan.startsWith('ai-zh'))
  if (aiZh) return aiZh
  return tracks[0]
}

function secondsToText(seconds) {
  const total = Number(seconds) || 0
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** 搜视频。order: totalrank（综合）/ click（最多播放）/ pubdate（最新）/ dm */
export async function searchVideos(keyword, credential, options = {}) {
  const order = ['totalrank', 'click', 'pubdate', 'dm'].includes(options.order) ? options.order : 'totalrank'
  const limit = Math.min(Math.max(Number(options.limit) || 10, 1), 50)
  const path = '/x/web-interface/search/type?search_type=video'
    + `&keyword=${encodeURIComponent(keyword)}&order=${order}&page=1`
  const { body } = await biliApi(path, credential)
  if (body?.code !== 0) {
    throw new Error(`搜索失败：code=${body?.code} ${body?.message ?? ''}`)
  }
  const list = Array.isArray(body.data?.result) ? body.data.result : []
  return list.slice(0, limit).map((item) => ({
    bvid: String(item.bvid ?? ''),
    title: stripHtml(item.title),
    author: String(item.author ?? ''),
    play: Number(item.play) || 0,
    danmaku: Number(item.video_review) || 0,
    duration: String(item.duration ?? ''),
    pubdate: Number(item.pubdate) || 0,
    description: stripHtml(item.description).slice(0, 240),
  }))
}

/** 视频详情（含分P的 aid/cid —— 读字幕要用）。 */
export async function videoInfo(bvid, credential) {
  const { body } = await biliApi(`/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, credential)
  if (body?.code !== 0) {
    throw new Error(`取视频详情失败：code=${body?.code} ${body?.message ?? ''}（BV 号是否正确？）`)
  }
  const data = body.data ?? {}
  return {
    bvid: String(data.bvid ?? bvid),
    aid: Number(data.aid),
    title: String(data.title ?? ''),
    author: String(data.owner?.name ?? ''),
    duration: secondsToText(data.duration),
    pubdate: Number(data.pubdate) || 0,
    view: Number(data.stat?.view) || 0,
    like: Number(data.stat?.like) || 0,
    reply: Number(data.stat?.reply) || 0,
    desc: String(data.desc ?? ''),
    pages: (Array.isArray(data.pages) ? data.pages : []).map((page) => ({
      page: Number(page.page) || 1,
      part: String(page.part ?? ''),
      cid: Number(page.cid),
      duration: secondsToText(page.duration),
    })),
  }
}

/**
 * 读字幕原文（这是判据的主来源）。
 * `wbi/v2` 给的语言轨更多（实测 6 条 vs 2 条的 1 条），所以先试它、失败再退回 v2。
 */
export async function videoSubtitles(bvid, credential, options = {}) {
  const info = await videoInfo(bvid, credential)
  const cid = Number(options.cid) || info.pages[0]?.cid
  if (!cid) throw new Error('这个视频没有可用的分P（拿不到 cid）')

  const tryPlayer = async (path) => {
    try {
      const { body } = await biliApi(path, credential)
      const tracks = body?.data?.subtitle?.subtitles
      return { body, tracks: Array.isArray(tracks) ? tracks : [] }
    } catch (err) {
      return { body: null, tracks: [] }
    }
  }

  let result = await tryPlayer(`/x/player/wbi/v2?aid=${info.aid}&cid=${cid}`)
  if (result.tracks.length === 0) {
    const fallback = await tryPlayer(`/x/player/v2?aid=${info.aid}&cid=${cid}`)
    if (fallback.tracks.length > 0) result = fallback
  }

  const tracks = result.tracks.map((track) => ({
    lan: toWellFormedText(track.lan),
    label: toWellFormedText(track.lan_doc),
    url: toWellFormedText(track.subtitle_url),
  }))
  if (tracks.length === 0) {
    return {
      bvid,
      title: info.title,
      tracks: [],
      text: '',
      note: '这个视频确实没有字幕轨（是它没有，不是我们读不到）',
    }
  }

  const requestedLan = options.lan ? String(options.lan) : ''
  const target = pickTrack(tracks, requestedLan)
  // ⚠️ 安全审查 S1：这里只做「补全协议」；https 强制与主机白名单统一在 `assertTrustedHttpsUrl`
  // 一处实现（biliGetAbsolute 里也会再校验一次），避免两处口径漂移。
  if (!target.url) {
    throw new Error('这一轨的 subtitle_url 是空的（接口没给地址）—— 已跳过，不发任何带凭证的请求')
  }
  const absolute = target.url.startsWith('//') ? `https:${target.url}` : target.url
  assertTrustedHttpsUrl(absolute) // 提前报清楚：地址不合规就不必发出带 Cookie 的请求
  const { body: subtitle } = await biliGetAbsolute(absolute, credential)
  const lines = Array.isArray(subtitle?.body) ? subtitle.body : []
  const text = lines
    // ⚠️ 2026-10-16 值班实测：字幕里混进过孤立代理项，不修就会被 DSH 工具层以
    // `value is not lossless JSON` 拦下（整包失败），所以这里逐行修 well-formed。
    .map((line) => toWellFormedText(line?.content).trim())
    .filter(Boolean)
    .join('\n')

  return {
    bvid,
    title: info.title,
    tracks,
    lan: target.lan,
    label: target.label,
    /** 调用方请求的轨（没请求就是 null）。 */
    requestedLan: requestedLan || null,
    /** true = 请求的轨不存在，实际用的是回落轨（会话据此在报告里标注依据）。 */
    fellBack: Boolean(requestedLan) && target.lan !== requestedLan,
    lineCount: lines.length,
    text,
    note: text ? '' : '拿到了字幕轨但正文是空的（少见，可能是该轨还在生成）',
  }
}

/**
 * 读评论（信息密度仅次于字幕）。
 * order：`'hot'`（默认，sort=2 热门）｜`'time'`（sort=0 按时间）。
 * ⚠️ 为什么必须有 time：热门排序只回前 20 条，**低赞评论根本进不去**。
 * 2026-10-16 实测踩过：复核自己刚发的评论时热门里查不到那条，于是既判不了成功、
 * 也判不了失败（差点误判成"没发出去"）。复核 rpid 必须 `order: 'time'`。
 */
export async function videoComments(bvid, credential, options = {}) {
  const info = await videoInfo(bvid, credential)
  const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 50)
  const pageSize = Math.min(limit, 20)
  const order = options.order === 'time' ? 'time' : 'hot'
  const sort = order === 'time' ? 0 : 2
  const { body } = await biliApi(
    `/x/v2/reply?type=1&oid=${info.aid}&sort=${sort}&ps=${pageSize}&pn=1`,
    credential,
  )
  if (body?.code !== 0) {
    throw new Error(`读评论失败：code=${body?.code} ${body?.message ?? ''}`)
  }
  const replies = Array.isArray(body.data?.replies) ? body.data.replies : []
  return {
    bvid,
    title: info.title,
    order,
    total: Number(body.data?.page?.count) || 0,
    comments: replies.slice(0, limit).map((reply) => ({
      rpid: String(reply.rpid_str ?? reply.rpid ?? ''),
      author: String(reply.member?.uname ?? ''),
      like: Number(reply.like) || 0,
      subReplies: Array.isArray(reply.replies) ? reply.replies.length : 0,
      message: String(reply.content?.message ?? '').slice(0, 500),
    })),
  }
}

/**
 * 发一条评论。
 * ⚠️ **未实测**：不能拿使用者账号做实验。端点与参数取自官方 Web 接口：
 *   POST x/v2/reply/add，form: oid=aid & type=1 & message=... & csrf=<bili_jct>
 * csrf 就是登录时拿到的 bili_jct；没有它一定发不出去。
 */
/**
 * 发一条评论。
 * ⚠️ 签名与同族函数统一为 `(bvid, text, credential, options)`（安全审查 D6）：
 * 原来是 `(bvid, text, options, credential)` —— 同族里独一份，改动时最容易传错位。
 */
export async function sendComment(bvid, text, credential, options = {}) {
  if (!credential?.sessdata) throw new Error('还没登录：先扫码登录再发评论')
  if (!credential?.biliJct) throw new Error('凭证里缺 bili_jct（csrf）—— 请重新扫码登录一次')

  const info = await videoInfo(bvid, credential)
  // ⚠️ 安全审查 D4：@ 对象是自由文本且直接进正文（用真人账号说话），先清洗再拼。
  const at = cleanAt(options.at)
  const body0 = String(text ?? '').trim()
  if (!body0) throw new Error('评论正文是空的')
  if (body0.length > 150) throw new Error(`评论正文 ${body0.length} 字，超过 150 字上限`)
  const message = at && !body0.includes(`@${at}`) ? `@${at} ${body0}` : body0
  // 150 字上限必须按**最终正文**再算一次（原来只算 body，拼上 @ 之后就超了）
  if (message.length > 150) throw new Error(`拼上 @ 之后正文 ${message.length} 字，超过 150 字上限`)

  const form = new URLSearchParams({
    oid: String(info.aid),
    type: '1',
    message,
    csrf: credential.biliJct,
    plat: '1',
  })
  let response
  try {
    response = await fetch('https://api.bilibili.com/x/v2/reply/add', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': BILI_UA,
        Referer: `https://www.bilibili.com/video/${info.bvid}`,
        Origin: 'https://www.bilibili.com',
        Cookie: cookieHeader(credential),
      },
      body: form.toString(),
      signal: AbortSignal.timeout(15000),
    })
  } catch (err) {
    // ⚠️ 安全审查 D5：超时/断网属于「歧义失败」—— 服务端可能已经落库、只是响应没回来。
    // 打上标记交给上层：按「已评论（待确认）」处理，避免下一轮对同一视频重复评论（真人账号不能被刷）。
    const ambiguous = new Error(`发评论请求没有拿到响应（可能已发出）：${brief(err?.message || err)}`)
    ambiguous.ambiguous = true
    throw ambiguous
  }
  const body = await response.json().catch(() => null)
  if (body === null) {
    const ambiguous = new Error(`发评论响应不是 JSON（HTTP ${response.status}）—— 服务端可能已落库`)
    ambiguous.ambiguous = true
    throw ambiguous
  }
  if (body?.code !== 0) {
    throw new Error(`发评论失败：code=${body?.code} ${brief(body?.message ?? `HTTP ${response.status}`)}`)
  }
  const rpid = String(body.data?.rpid_str ?? body.data?.rpid ?? '')
  return {
    ok: true,
    bvid: info.bvid,
    aid: info.aid,
    rpid,
    message,
    sentAt: new Date().toISOString(),
    // ⚠️ 接口成功 ≠ 公开可见：B站 评论计数有 5–10 分钟延迟，必须延迟复核
    verifyNote: '接口返回成功不等于公开可见；B站计数有 5–10 分钟延迟，必须延迟复核（bili_duty_verify_in）。',
  }
}
