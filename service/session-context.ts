import { readFile } from 'node:fs/promises'

export interface SessionContextMessage {
  role: 'user' | 'assistant' | 'toolResult' | 'custom' | 'branchSummary' | 'compactionSummary'
  text: string
}

// Rendering: pi's serializeConversation collapses everything into one
// `[User]: ...` / `[Assistant]: ...` / `[Tool result]: ...` string (with the
// summary prefixes below via convertToLlm). We instead keep one {role, text}
// per message so the handoff prompt can format the transcript; text
// extraction mirrors contentText (text blocks joined with "\n", images
// dropped), plus thinking blocks by their text and toolCall blocks by tool
// name. Prefixes copied verbatim from pi-coding-agent's messages.js.
const COMPACTION_SUMMARY_PREFIX =
  'The conversation history before this point was compacted into the following summary:\n\n<summary>\n'
const COMPACTION_SUMMARY_SUFFIX = '\n</summary>'
const BRANCH_SUMMARY_PREFIX =
  'The following is a summary of a branch that this conversation came back from:\n\n<summary>\n'
const BRANCH_SUMMARY_SUFFIX = '</summary>'

type Entry = Record<string, any>

function renderContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text') {
      if (typeof block.text === 'string') parts.push(block.text)
    } else if (block.type === 'thinking') {
      if (typeof block.text === 'string') parts.push(block.text)
      else if (typeof block.thinking === 'string') parts.push(block.thinking)
    } else if (block.type === 'toolCall') {
      if (typeof block.name === 'string') parts.push(block.name)
    }
    // image and unknown blocks contribute nothing
  }
  return parts.join('\n')
}

function entryMessages(entry: Entry, edit: Entry | undefined): SessionContextMessage[] {
  if (entry.type === 'message') {
    const message = entry.message ?? {}
    if (message.role === 'system') return []
    if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'toolResult') {
      return []
    }
    if (edit) {
      if (edit.replacement === null) return []
      const content = edit.replacement?.content
      const wrapped =
        typeof content === 'string' && message.role !== 'user'
          ? [{ type: 'text', text: content }]
          : content
      return [{ role: message.role, text: renderContent(wrapped) }]
    }
    return [{ role: message.role, text: renderContent(message.content) }]
  }
  if (entry.type === 'custom_message') {
    if (edit) {
      if (edit.replacement === null) return []
      return [{ role: 'custom', text: renderContent(edit.replacement?.content) }]
    }
    return [{ role: 'custom', text: renderContent(entry.content) }]
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
  for (const entry of path) {
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
