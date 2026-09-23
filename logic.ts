/**
 * Pure handoff helpers. Type-only imports so tests load this without pi's
 * extension alias resolution.
 */

import type { SessionHeader } from '@earendil-works/pi-coding-agent'

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
