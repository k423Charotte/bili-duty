/**
 * 极简 QR 编码器（纯 JS，零依赖）—— 只为画「扫码登录」那张码。
 * ============================================================================
 * 为什么自己写：B站 扫码登录要求把 `qrcode/generate` 给的登录 url 变成一张**二维码图片**，
 * 而 DSH 里没有可复用的 QR 实现、我们又不想为了画张图引入依赖（对照 dsh-bili-scroll：
 * 它为此专门用 Python 的 qrcode 库画 PNG）。
 *
 * 实现范围：字节模式（8-bit byte）+ 纠错级别 L/M/Q/H + 版本 1–40 + 8 种掩码自动择优。
 * 不做：数字/字母数字混合模式优化（URL 长度用不上，且会让矩阵难以对齐参照）。
 *
 * ⚠️ 正确性保障：本文件的输出与 Python `qrcode 8.2`（`optimize=0`，即纯字节模式）
 * **逐格一致**，由 tools/qr-test.mjs 对 3 组内容 × 9 种掩码（含自动择优）比对。
 */

import { RS_BLOCKS, ALIGN_POS } from './qr-tables.js'

const EC_LEVEL_INDEX = { L: 0, M: 1, Q: 2, H: 3 }
/** 格式信息里用的级别位（注意不是下标：L=01 M=00 Q=11 H=10）。 */
const EC_FORMAT_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 }

// ── GF(256)，本原多项式 0x11d ─────────────────────────────────────────────
const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255]
}

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0
  return GF_EXP[GF_LOG[a] + GF_LOG[b]]
}

/** Reed-Solomon 生成多项式（系数从最高次开始，首项恒为 1）。 */
function generatorPoly(degree) {
  let poly = [1]
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j]
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i])
    }
    poly = next
  }
  return poly
}

function rsEncode(dataBytes, ecCount) {
  const gen = generatorPoly(ecCount)
  const remainder = new Array(ecCount).fill(0)
  for (const byte of dataBytes) {
    const factor = byte ^ remainder[0]
    remainder.shift()
    remainder.push(0)
    if (factor !== 0) {
      for (let i = 0; i < ecCount; i += 1) remainder[i] ^= gfMul(gen[i + 1], factor)
    }
  }
  return remainder
}

// ── 块结构 ───────────────────────────────────────────────────────────────

function blockGroups(version, levelIndex) {
  const raw = RS_BLOCKS[version - 1][levelIndex]
  const groups = []
  for (let i = 0; i < raw.length; i += 3) {
    groups.push({ count: raw[i], total: raw[i + 1], data: raw[i + 2] })
  }
  return groups
}

function dataCapacity(version, levelIndex) {
  return blockGroups(version, levelIndex).reduce((sum, group) => sum + group.count * group.data, 0)
}

function pickVersion(byteLength, levelIndex) {
  for (let version = 1; version <= 40; version += 1) {
    const capacityBits = dataCapacity(version, levelIndex) * 8
    const countBits = version <= 9 ? 8 : 16
    if (4 + countBits + byteLength * 8 <= capacityBits) return version
  }
  return null
}

// ── 位流 → 码字 → 交织 ────────────────────────────────────────────────────

function buildCodewords(bytes, version, levelIndex) {
  const capacityBits = dataCapacity(version, levelIndex) * 8
  const bits = []
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1)
  }

  push(0b0100, 4) // 字节模式
  push(bytes.length, version <= 9 ? 8 : 16)
  for (const byte of bytes) push(byte, 8)

  for (let i = 0; i < Math.min(4, capacityBits - bits.length); i += 1) bits.push(0)
  while (bits.length % 8 !== 0) bits.push(0)
  const padBytes = [0xec, 0x11]
  let padIndex = 0
  while (bits.length < capacityBits) {
    push(padBytes[padIndex % 2], 8)
    padIndex += 1
  }

  const codewords = []
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0
    for (let j = 0; j < 8; j += 1) value = (value << 1) | bits[i + j]
    codewords.push(value)
  }
  return codewords
}

function interleaveBlocks(codewords, version, levelIndex) {
  const groups = blockGroups(version, levelIndex)
  const dataBlocks = []
  let offset = 0
  for (const group of groups) {
    for (let i = 0; i < group.count; i += 1) {
      dataBlocks.push(codewords.slice(offset, offset + group.data))
      offset += group.data
    }
  }
  const ecCount = groups[0].total - groups[0].data
  const ecBlocks = dataBlocks.map((block) => rsEncode(block, ecCount))

  const result = []
  const maxData = Math.max(...dataBlocks.map((block) => block.length))
  for (let i = 0; i < maxData; i += 1) {
    for (const block of dataBlocks) if (i < block.length) result.push(block[i])
  }
  for (let i = 0; i < ecCount; i += 1) {
    for (const block of ecBlocks) result.push(block[i])
  }
  return result
}

// ── 矩阵 ─────────────────────────────────────────────────────────────────

function createMatrix(version) {
  const size = version * 4 + 17
  const modules = Array.from({ length: size }, () => new Array(size).fill(false))
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false))

  // ① 版本信息区（v≥7）—— 参照实现第一步就把它占住
  if (version >= 7) {
    for (let i = 0; i < 6; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        reserved[size - 11 + j][i] = true
        reserved[i][size - 11 + j] = true
      }
    }
  }

  // ② 定位图案 + 分隔符
  const placeFinder = (top, left) => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const row = top + r
        const col = left + c
        if (row < 0 || row >= size || col < 0 || col >= size) continue
        const onRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6))
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4
        modules[row][col] = onRing || inCore
        reserved[row][col] = true
      }
    }
  }
  placeFinder(0, 0)
  placeFinder(0, size - 7)
  placeFinder(size - 7, 0)

  // ③ 对齐图案 —— 必须在时序图案**之前**（参照实现的顺序：probe → adjust → timing）。
  // ⚠️ 判定粒度是「**中心**」：中心已被占就**整体跳过**；否则**无条件写满整个 5×5**。
  // 逐格判断是错的：v3 的对齐图案中心 (6,22) 正好落在右上定位图案范围内，
  // 参照会跳过它，于是 (4,20)、(5,20)… 这些格子留作数据格；
  // 逐格判断反而会把它们占成功能格，数据格少 8 个，整条数据放置路径随之错位。
  const positions = ALIGN_POS[version - 1]
  for (const row of positions) {
    for (const col of positions) {
      if (reserved[row][col]) continue
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          modules[row + r][col + c] = Math.max(Math.abs(r), Math.abs(c)) !== 1
          reserved[row + r][col + c] = true
        }
      }
    }
  }

  // ④ 时序图案（只补还空着的格子）
  for (let i = 8; i < size - 8; i += 1) {
    const dark = i % 2 === 0
    if (!reserved[6][i]) { modules[6][i] = dark; reserved[6][i] = true }
    if (!reserved[i][6]) { modules[i][6] = dark; reserved[i][6] = true }
  }

  // ⑤ 固定的暗模块 + 格式信息区域占位
  modules[size - 8][8] = true
  reserved[size - 8][8] = true
  for (let i = 0; i < 9; i += 1) {
    reserved[8][i] = true
    reserved[i][8] = true
  }
  for (let i = 0; i < 8; i += 1) {
    reserved[8][size - 1 - i] = true
    reserved[size - 1 - i][8] = true
  }

  return { size, modules, reserved }
}

const MASK_FUNCS = [
  (row, col) => (row + col) % 2 === 0,
  (row) => row % 2 === 0,
  (_row, col) => col % 3 === 0,
  (row, col) => (row + col) % 3 === 0,
  (row, col) => (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0,
  (row, col) => ((row * col) % 2) + ((row * col) % 3) === 0,
  (row, col) => (((row * col) % 2) + ((row * col) % 3)) % 2 === 0,
  (row, col) => (((row + col) % 2) + ((row * col) % 3)) % 2 === 0,
]

function placeData(matrix, codewords, mask) {
  const { size, modules, reserved } = matrix
  const maskFunc = MASK_FUNCS[mask]
  const bits = []
  for (const byte of codewords) {
    for (let i = 7; i >= 0; i -= 1) bits.push((byte >>> i) & 1)
  }

  let index = 0
  let direction = -1
  let row = size - 1
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1 // 跳过时序列
    for (;;) {
      for (let c = 0; c < 2; c += 1) {
        const target = col - c
        if (reserved[row][target]) continue
        let dark = index < bits.length ? bits[index] === 1 : false
        index += 1
        if (maskFunc(row, target)) dark = !dark
        modules[row][target] = dark
      }
      row += direction
      if (row < 0 || row >= size) {
        row -= direction
        direction = -direction
        break
      }
    }
  }
}

function bchDigit(value) {
  let digit = 0
  let rest = value
  while (rest !== 0) {
    digit += 1
    rest >>>= 1
  }
  return digit
}

function formatInfoBits(level, mask) {
  const data = (EC_FORMAT_BITS[level] << 3) | mask
  let rest = data << 10
  while (bchDigit(rest) - bchDigit(0x537) >= 0) {
    rest ^= 0x537 << (bchDigit(rest) - bchDigit(0x537))
  }
  return ((data << 10) | rest) ^ 0x5412
}

function versionInfoBits(version) {
  let rest = version << 12
  while (bchDigit(rest) - bchDigit(0x1f25) >= 0) {
    rest ^= 0x1f25 << (bchDigit(rest) - bchDigit(0x1f25))
  }
  return (version << 12) | rest
}

function setupTypeInfo(matrix, level, mask) {
  const { size, modules } = matrix
  const bits = formatInfoBits(level, mask)
  for (let i = 0; i < 15; i += 1) {
    const dark = ((bits >> i) & 1) === 1
    if (i < 6) modules[i][8] = dark
    else if (i < 8) modules[i + 1][8] = dark
    else modules[size - 15 + i][8] = dark

    if (i < 8) modules[8][size - i - 1] = dark
    else if (i < 9) modules[8][15 - i - 1 + 1] = dark
    else modules[8][15 - i - 1] = dark
  }
  modules[size - 8][8] = true
}

function setupTypeNumber(matrix, version) {
  const { size, modules } = matrix
  const bits = versionInfoBits(version)
  for (let i = 0; i < 18; i += 1) {
    const dark = ((bits >> i) & 1) === 1
    modules[Math.floor(i / 3)][(i % 3) + size - 8 - 3] = dark
    modules[(i % 3) + size - 8 - 3][Math.floor(i / 3)] = dark
  }
}

/**
 * 掩码惩罚分 —— 逐条对齐 Python `qrcode.util.lost_point`：
 * level1 连续同色长度表、level2 2×2 同色、level3 10111010000/00001011101、level4 深色比例。
 * 掩码择优必须与参照一致，否则矩阵会分叉（两边都合法，但没法逐格比对）。
 */
function lostPoint(modules) {
  const size = modules.length
  let total = 0

  // level 1：行/列连续同色 ≥5
  {
    const container = new Array(size + 1).fill(0)
    for (let row = 0; row < size; row += 1) {
      let previous = modules[row][0]
      let length = 0
      for (let col = 0; col < size; col += 1) {
        if (modules[row][col] === previous) {
          length += 1
        } else {
          if (length >= 5) container[length] += 1
          length = 1
          previous = modules[row][col]
        }
      }
      if (length >= 5) container[length] += 1
    }
    for (let col = 0; col < size; col += 1) {
      let previous = modules[0][col]
      let length = 0
      for (let row = 0; row < size; row += 1) {
        if (modules[row][col] === previous) {
          length += 1
        } else {
          if (length >= 5) container[length] += 1
          length = 1
          previous = modules[row][col]
        }
      }
      if (length >= 5) container[length] += 1
    }
    for (let length = 5; length <= size; length += 1) total += container[length] * (length - 2)
  }

  // level 2：2×2 全同色
  for (let row = 0; row < size - 1; row += 1) {
    for (let col = 0; col < size - 1; col += 1) {
      const topRight = modules[row][col + 1]
      if (topRight === modules[row + 1][col + 1]
        && topRight === modules[row][col]
        && topRight === modules[row + 1][col]) total += 3
    }
  }

  // level 3：类定位图案（含两侧 4 个浅色）
  const matchesAt = (line, start) => {
    const at = (offset) => line[start + offset]
    if (at(1) || !at(4) || at(5) || !at(6) || at(9)) return false
    const left = at(0) && at(2) && at(3) && !at(7) && !at(8) && !at(10)
    const right = !at(0) && !at(2) && !at(3) && at(7) && at(8) && at(10)
    return Boolean(left || right)
  }
  for (let row = 0; row < size; row += 1) {
    const line = modules[row]
    for (let col = 0; col + 10 < size; col += 1) {
      if (matchesAt(line, col)) total += 40
      // 与参照实现相同的 Horspool 跳跃
      if (line[col + 10]) col += 1
    }
  }
  for (let col = 0; col < size; col += 1) {
    const line = []
    for (let row = 0; row < size; row += 1) line.push(modules[row][col])
    for (let start = 0; start + 10 < size; start += 1) {
      if (matchesAt(line, start)) total += 40
      if (line[start + 10]) start += 1
    }
  }

  // level 4：深色比例偏离 50%
  let dark = 0
  for (const row of modules) for (const cell of row) if (cell) dark += 1
  const percent = dark / (size * size)
  total += Math.trunc(Math.abs(percent * 100 - 50) / 5) * 10

  return total
}

/**
 * 把文本编码成 QR 矩阵。
 * @param {string} text
 * @param {{ecLevel?: 'L'|'M'|'Q'|'H', mask?: number, version?: number}} [options]
 * @returns {{text: string, version: number, size: number, mask: number, modules: boolean[][]}}
 */
export function encodeQr(text, options = {}) {
  const ecLevel = EC_LEVEL_INDEX[options.ecLevel] === undefined ? 'M' : options.ecLevel
  const levelIndex = EC_LEVEL_INDEX[ecLevel]
  const explicitMask = Number.isInteger(options.mask) && options.mask >= 0 && options.mask <= 7
    ? options.mask
    : null
  const bytes = new TextEncoder().encode(text)

  // ⚠️ 安全审查 D1：显式 version 必须校验「范围」与「容量」。
  // 原实现 version=41/-3 会越界读 `RS_BLOCKS[40]` 抛 TypeError 冲进调用方；
  // 容量不足时更糟 —— buildCodewords 会把放不下的数据**静默丢掉**，产出一张扫不动的码却不报错。
  let version
  if (options.version === undefined || options.version === null) {
    version = pickVersion(bytes.length, levelIndex)
    if (!version) throw new Error(`内容太长，超过 QR 版本 40 的容量（${bytes.length} 字节）`)
  } else {
    if (!Number.isInteger(options.version) || options.version < 1 || options.version > 40) {
      throw new Error(`version 必须是 1..40 的整数，收到 ${JSON.stringify(options.version)}`)
    }
    version = options.version
    const capacityBits = dataCapacity(version, levelIndex) * 8
    const countBits = version <= 9 ? 8 : 16
    if (4 + countBits + bytes.length * 8 > capacityBits) {
      throw new Error(
        `内容 ${bytes.length} 字节放不进 version ${version}（${ecLevel} 级，容量 ${capacityBits} bit）——调大 version 或缩短内容`,
      )
    }
  }

  const codewords = interleaveBlocks(buildCodewords(bytes, version, levelIndex), version, levelIndex)

  let best = null
  const candidates = explicitMask === null ? [0, 1, 2, 3, 4, 5, 6, 7] : [explicitMask]
  for (const mask of candidates) {
    const matrix = createMatrix(version)
    placeData(matrix, codewords, mask)
    setupTypeInfo(matrix, levelIndex, mask)
    if (version >= 7) setupTypeNumber(matrix, version)
    const score = explicitMask === null ? lostPoint(matrix.modules) : 0
    if (best === null || score < best.score) {
      best = { mask, score, modules: matrix.modules, size: matrix.size, reserved: matrix.reserved }
    }
  }

  return {
    text,
    version,
    size: best.size,
    mask: best.mask,
    modules: best.modules,
    /** 功能图案/保留区掩码（调试与测试用：数据格数是否与参照一致，靠它判定）。 */
    reserved: best.reserved,
  }
}

/** 只接受 `#rgb` / `#rrggbb` / `#rrggbbaa`（安全审查 D2：这些值会被原样拼进 SVG 属性）。 */
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/
function safeColor(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string' || !COLOR_RE.test(value)) {
    throw new Error(`${label} 必须是 #rgb / #rrggbb(aa) 形式的颜色，收到 ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * 矩阵 → SVG 字符串（矢量、无依赖；由调用方决定怎么嵌进页面）。
 * @param {boolean[][]} modules
 * @param {{scale?: number, margin?: number, dark?: string, light?: string}} [options]
 */
export function qrToSvg(modules, options = {}) {
  if (!Array.isArray(modules) || modules.length === 0 || !Array.isArray(modules[0])) {
    throw new Error('qrToSvg 需要一个非空方阵（encodeQr 返回的 modules）')
  }
  const size = modules.length
  // ⚠️ 安全审查 D2：scale/margin 会被拼进 SVG 属性，必须约束为有限数字
  // （原实现传 `scale: '4" onload="'` 会产出 width="NaN"，传负 margin 会把图裁掉）。
  const rawScale = options.scale === undefined ? 6 : Number(options.scale)
  if (!Number.isFinite(rawScale) || rawScale <= 0) {
    throw new Error(`scale 必须是正数，收到 ${JSON.stringify(options.scale)}`)
  }
  const scale = Math.min(Math.max(Math.trunc(rawScale), 1), 64)
  const rawMargin = options.margin === undefined ? 2 : Number(options.margin)
  if (!Number.isFinite(rawMargin)) {
    throw new Error(`margin 必须是数字，收到 ${JSON.stringify(options.margin)}`)
  }
  const margin = Math.min(Math.max(Math.trunc(rawMargin), 0), 64)
  const dimension = (size + margin * 2) * scale
  const dark = safeColor(options.dark, '#000000', 'dark')
  const light = safeColor(options.light, '#ffffff', 'light')

  let path = ''
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (!modules[row][col]) continue
      const x = (col + margin) * scale
      const y = (row + margin) * scale
      path += `M${x} ${y}h${scale}v${scale}h-${scale}z`
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dimension}" height="${dimension}" `
    + `viewBox="0 0 ${dimension} ${dimension}" shape-rendering="crispEdges" role="img" aria-label="登录二维码">`
    + `<rect width="${dimension}" height="${dimension}" fill="${light}"/>`
    + `<path fill="${dark}" d="${path}"/></svg>`
}
