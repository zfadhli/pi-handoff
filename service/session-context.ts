import { readFile } from 'node:fs/promises'

export interface SessionContextMessage {
  role:
    | 'user'
    | 'assistant'
    | 'assistantThinking'
    | 'assistantToolCalls'
    | 'toolResult'
    | 'custom'
    | 'branchSummary'
    | 'compactionSummary'
  text: string
}

// Rendering mirrors pi-coding-agent's convertToLlm + serializeConversation
// (dist/core/messages.js + dist/core/compaction/utils.js): one
// SessionContextMessage per serialized part. User/toolResult/custom text
// blocks join with "" (contentText sep), assistant text blocks with "\n",
// thinking blocks emit a separate part joined with "\n", toolCall blocks
// emit `name(k=JSON(v), ...)` joined with "; ". bashExecution entries render
// via bashExecutionToText as user text. Prefixes copied verbatim from pi's
// messages.js.
const COMPACTION_SUMMARY_PREFIX =
  'The conversation history before this point was compacted into the following summary:\n\n<summary>\n'
const COMPACTION_SUMMARY_SUFFIX = '\n</summary>'
const BRANCH_SUMMARY_PREFIX =
  'The following is a summary of a branch that this conversation came back from:\n\n<summary>\n'
const BRANCH_SUMMARY_SUFFIX = '</summary>'

type Entry = Record<string, any>

// pi pi-ai contentText: string passes through; only text blocks kept, images
// and unknown blocks dropped.
function contentText(content: unknown, separator: string): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text') {
      if (typeof block.text === 'string') parts.push(block.text)
    }
  }
  return parts.join(separator)
}

// pi messages.js bashExecutionToText, verbatim.
function bashExecutionToText(msg: Entry): string {
  let text = `Ran \`${msg.command}\`\n`
  if (msg.output) {
    text += `\`\`\`\n${msg.output}\n\`\`\``
  } else {
    text += '(no output)'
  }
  if (msg.cancelled) {
    text += '\n\n(command cancelled)'
  } else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
    text += `\n\nCommand exited with code ${msg.exitCode}`
  }
  if (msg.truncated && msg.fullOutputPath) {
    text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`
  }
  return text
}

// pi serializeConversation assistant branch: thinking parts, text part (only
// when a text block exists), tool-call parts with JSON args.
function renderAssistant(content: unknown): SessionContextMessage[] {
  if (typeof content === 'string') return content ? [{ role: 'assistant', text: content }] : []
  if (!Array.isArray(content)) return []
  const thinkingParts: string[] = []
  const toolCalls: string[] = []
  let hasText = false
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'thinking') {
      thinkingParts.push(block.thinking)
    } else if (block.type === 'toolCall') {
      const args =
        block.arguments != null && typeof block.arguments === 'object' ? block.arguments : {}
      const argsStr = Object.entries(args)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(', ')
      if (typeof block.name === 'string') toolCalls.push(`${block.name}(${argsStr})`)
    } else if (block.type === 'text') {
      hasText = true
    }
  }
  const out: SessionContextMessage[] = []
  if (thinkingParts.length > 0)
    out.push({ role: 'assistantThinking', text: thinkingParts.join('\n') })
  if (hasText) out.push({ role: 'assistant', text: contentText(content, '\n') })
  if (toolCalls.length > 0) out.push({ role: 'assistantToolCalls', text: toolCalls.join('; ') })
  return out
}

function entryMessages(entry: Entry, edit: Entry | undefined): SessionContextMessage[] {
  if (entry.type === 'message') {
    const message = entry.message ?? {}
    if (message.role === 'system') return []
    // pi projectContextEntry: null replacement drops; other roles keep their
    // content except user/assistant/toolResult/custom, whose content is
    // replaced (string replacement wraps for assistant/toolResult).
    let effective = message
    if (edit) {
      if (edit.replacement === null) return []
      if (
        message.role === 'user' ||
        message.role === 'assistant' ||
        message.role === 'toolResult' ||
        message.role === 'custom'
      ) {
        const content =
          (message.role === 'assistant' || message.role === 'toolResult') &&
          typeof edit.replacement?.content === 'string'
            ? [{ type: 'text', text: edit.replacement.content }]
            : edit.replacement?.content
        effective = { ...message, content }
      }
    }
    switch (effective.role) {
      case 'user': {
        const text = contentText(effective.content, '')
        return text ? [{ role: 'user', text }] : []
      }
      case 'assistant':
        return renderAssistant(effective.content)
      case 'toolResult': {
        const text = contentText(effective.content, '')
        return text ? [{ role: 'toolResult', text }] : []
      }
      case 'custom': {
        const text = contentText(effective.content, '')
        return text ? [{ role: 'custom', text }] : []
      }
      case 'bashExecution': {
        if (effective.excludeFromContext) return []
        return [{ role: 'user', text: bashExecutionToText(effective) }]
      }
      default:
        return []
    }
  }
  if (entry.type === 'custom_message') {
    if (edit) {
      if (edit.replacement === null) return []
      const text = contentText(edit.replacement?.content, '')
      return text ? [{ role: 'custom', text }] : []
    }
    const text = contentText(entry.content, '')
    return text ? [{ role: 'custom', text }] : []
  }
  if (entry.type === 'branch_summary' && typeof entry.summary === 'string') {
    return [
      {
        role: 'branchSummary',
        text: BRANCH_SUMMARY_PREFIX + entry.summary + BRANCH_SUMMARY_SUFFIX,
      },
    ]
  }
  if (entry.type === 'compaction' && typeof entry.summary === 'string') {
    return [
      {
        role: 'compactionSummary',
        text: COMPACTION_SUMMARY_PREFIX + entry.summary + COMPACTION_SUMMARY_SUFFIX,
      },
    ]
  }
  return []
}

export function buildSessionContext(jsonl: string): SessionContextMessage[] {
  const lines = jsonl
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (lines.length <= 1) return []
  const entries = lines.slice(1).map((line) => JSON.parse(line) as Entry)
  const byId = new Map<string, Entry>()
  for (const entry of entries) {
    if (typeof entry.id === 'string') byId.set(entry.id, entry)
  }
  // Leaf = last non-header line; walk parentId to root for the active path.
  const seen = new Set<string>()
  const path: Entry[] = []
  let current: Entry | undefined = entries[entries.length - 1]
  while (current && typeof current.id === 'string' && !seen.has(current.id)) {
    seen.add(current.id)
    path.unshift(current)
    current = typeof current.parentId === 'string' ? byId.get(current.parentId) : undefined
  }
  let compaction: Entry | null = null
  for (const entry of path) {
    if (entry.type === 'compaction') compaction = entry
  }
  let selected: Entry[]
  if (!compaction) {
    selected = path
  } else {
    const kept: Entry[] = [compaction]
    let keep = false
    for (const entry of path) {
      if (entry === compaction) break
      if (entry.id === (compaction as Entry).firstKeptEntryId) keep = true
      if (keep && !(entry.type === 'message' && entry.message?.role === 'system')) kept.push(entry)
    }
    kept.push(...path.slice(path.indexOf(compaction) + 1))
    selected = kept
  }
  const edits = new Map<string, Entry>()
  // pi buildSessionProjection collects edits from the compaction-filtered
  // context entries, not the raw path.
  for (const entry of selected) {
    if (entry.type === 'context_edit' && typeof entry.targetId === 'string') {
      edits.set(entry.targetId, entry)
    }
  }
  const messages: SessionContextMessage[] = []
  selected.forEach((entry, index) => {
    // An older compaction inside the kept range contributes no message.
    if (entry.type === 'compaction' && index > 0) return
    messages.push(...entryMessages(entry, edits.get(entry.id)))
  })
  return messages
}

export async function readSessionContext(file: string): Promise<SessionContextMessage[]> {
  return buildSessionContext(await readFile(file, 'utf8'))
}
