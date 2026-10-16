/**
 * 离线测试用的 loader 钩子：把 `@deepseek-ai/dsh-llm` 解析到本地等价 stub。
 *
 * 为什么需要它：真实运行时由 DSH 宿主提供 `@deepseek-ai/dsh-llm` 的解析，
 * 而 `node tools/smoke-test.mjs` 是脱离宿主的离线进程，裸导入会
 * `ERR_MODULE_NOT_FOUND`（2026-10-16 修「缺 role」bug 时踩到）。
 * stub 只补出测试需要的 `createUserMessage`，语义与官方一致（补 role + id）。
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/dsh-llm' || specifier.startsWith('@deepseek-ai/dsh-llm/')) {
    return { url: new URL('./dsh-llm-stub.mjs', import.meta.url).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
