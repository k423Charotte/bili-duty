/**
 * `@deepseek-ai/dsh-llm` 的离线 stub —— 仅用于 `tools/` 里的测试进程。
 * 语义对齐官方实现（dsh-llm/lib/types/message.js）：`createMessage` 补 id、
 * `createUserMessage` 再补 `role: 'user'`。生产环境永远用宿主提供的真包。
 */
import { randomUUID } from 'node:crypto'

export function createMessage(input) {
  return { ...input, id: randomUUID() }
}

export function createUserMessage(input) {
  return createMessage({ ...input, role: 'user' })
}

export function createDeveloperMessage(input) {
  return createMessage({ ...input, role: 'developer' })
}

export function createAssistantMessage(input) {
  return createMessage({ role: 'assistant', content: input.content, source: { kind: 'model', ...input.source } })
}
