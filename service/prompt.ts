import { SYSTEM_PROMPT } from '../logic.ts'
import type { SessionContextMessage } from './session-context.ts'

// Mirrors pi-coding-agent@1.0.0 dist/core/compaction/utils.js: serializeConversation
// after convertToLlm. Custom/branch/compaction summaries arrive as user text
// (prefixes already applied by session-context.ts); tool results truncate at 2000 chars.
const TOOL_RESULT_MAX_CHARS = 2000

function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} more characters truncated]`
}

export function serializeMessages(messages: SessionContextMessage[]): string {
  const parts: string[] = []
  for (const msg of messages) {
    if (!msg.text) continue
    if (
      msg.role === 'user' ||
      msg.role === 'custom' ||
      msg.role === 'branchSummary' ||
      msg.role === 'compactionSummary'
    ) {
      parts.push(`[User]: ${msg.text}`)
    } else if (msg.role === 'assistant') {
      parts.push(`[Assistant]: ${msg.text}`)
    } else if (msg.role === 'toolResult') {
      parts.push(`[Tool result]: ${truncateForSummary(msg.text, TOOL_RESULT_MAX_CHARS)}`)
    }
  }
  return parts.join('\n\n')
}

export function buildGenerationInput(
  goal: string,
  conversationText: string,
): { systemPrompt: string; userContent: string } {
  return {
    systemPrompt: SYSTEM_PROMPT,
    userContent: `## Conversation History\n\n${conversationText}\n\n## User's Goal for New Thread\n\n${goal}`,
  }
}

export function finalizePrompt(generated: string, sessionSection: string): string {
  return generated + sessionSection
}
