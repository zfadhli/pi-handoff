/**
 * Pure handoff helpers. Type-only imports so tests load this without pi's
 * extension alias resolution.
 */

import type { SessionHeader } from '@earendil-works/pi-coding-agent'

export const SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained - the new thread should be able to proceed without the old conversation

Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like "Here's the prompt" - just output the prompt itself.

Example output format:
## Context
We've been working on X. Key decisions:
- Decision 1
- Decision 2

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Task
[Clear description of what to do next based on user's goal]`

/** Current session file first, then each ancestor via its header's parentSession. */
export async function collectSessionChain(
  currentSessionFile: string | undefined,
  readHeader: (file: string) => Promise<SessionHeader | null>,
): Promise<string[]> {
  if (!currentSessionFile) return []
  const chain = [currentSessionFile]
  const seen = new Set(chain)
  let parent = (await readHeader(currentSessionFile))?.parentSession
  while (parent && !seen.has(parent)) {
    chain.push(parent)
    seen.add(parent)
    parent = (await readHeader(parent))?.parentSession
  }
  return chain
}

export function sessionHistorySection(chain: string[]): string {
  if (chain.length === 0) return ''
  return `\n\n## Session History\nPrevious sessions (most recent first):\n${chain
    .map((s, i) => `${i + 1}. ${s}`)
    .join('\n')}\n\nUse \`pi --session <path>\` to review any session if needed.`
}
