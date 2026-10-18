/** 探测 /plugins 组合路由，弄清客户端 bundle 到底能不能取到。 */
import { statSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const PORT = process.env.DSH_PORT || 43189
// ⚠️ 必须用相对路径：这个文件会进公开仓库。原先硬编码作者本机路径（`E:/AI/deepseek/...`）
// 既把私有目录名写进了开源代码，也让别人克隆后根本跑不了。
const FILE = fileURLToPath(new URL('../lib/client.js', import.meta.url))

function framedHash(domain, parts) {
  const hash = createHash('sha1').update(domain).update('\0')
  for (const part of parts) hash.update(`${String(Buffer.byteLength(part))}:`).update(part)
  return hash.digest('hex').slice(0, 12)
}
const st = statSync(FILE)
const rev = framedHash('plugin-artifact', [String(st.mtimeMs), String(st.ctimeMs), String(st.size)])
console.log('client.js size', st.size, 'rev', rev)

const urls = [
  `/plugins/bili-duty/client.js`,
  `/plugins/bili-duty/client.js?rev=${rev}`,
  `/plugins/??bili-duty/client.js&rev=${rev}`,
  `/plugins/??bili-duty/client.js&rev=000000000000`,
  `/bili-duty/client.js`,
  `/bili-duty/client-modules.json`,
  `/bili-duty/state.json`,
]

for (const u of urls) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}${u}`, { redirect: 'manual' })
    const text = await res.text()
    console.log(`${String(res.status).padEnd(4)} ${u}  (${text.length} bytes)`)
    if (res.status === 200) console.log('     head:', JSON.stringify(text.slice(0, 120)))
  } catch (err) {
    console.log(`ERR  ${u}  ${String(err.message || err)}`)
  }
}
