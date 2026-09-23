/**
 * Handoff extension - transfer context to a new focused session.
 *
 * Instead of compacting (lossy), handoff summarizes what matters for the next
 * task into a self-contained prompt, links the parent-session chain for full
 * recovery, and starts a new session with the prompt as an editable draft.
 *
 * Usage:
 *   /handoff now implement this for teams as well
 *   /handoff execute phase one of the plan
 *
 * Post-switch UI work runs inside `newSession({ withSession })`: pre-replacement
 * `ctx` is invalidated after a session switch and throws on use. Generation uses
 * `ctx.modelRegistry.complete()`, and the branch is read compaction-aware via
 * `buildContextEntries()` so compacted sessions hand off real context.
 */

import { type Message, uuidv7 } from '@earendil-works/pi-ai'
import type { ExtensionAPI, SessionHeader } from '@earendil-works/pi-coding-agent'
import {
  BorderedLoader,
  convertToLlm,
  serializeConversation,
  sessionEntryToContextMessages,
} from '@earendil-works/pi-coding-agent'
import { collectSessionChain, sessionHistorySection } from './logic.js'

const SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

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

export default function handoff(pi: ExtensionAPI): void {
  pi.registerCommand('handoff', {
    description: 'Transfer context to a new focused session',
    handler: async (args, ctx) => {
      if (ctx.mode !== 'tui') {
        ctx.ui.notify('handoff requires interactive mode', 'error')
        return
      }
      if (!ctx.model) {
        ctx.ui.notify('No model selected', 'error')
        return
      }
      const goal = args.trim()
      if (!goal) {
        ctx.ui.notify('Usage: /handoff <goal for new thread>', 'error')
        return
      }

      // Compaction-aware leaf path, so a compacted session still hands off real context.
      const messages = ctx.sessionManager
        .buildContextEntries()
        .flatMap(sessionEntryToContextMessages)
      if (messages.length === 0) {
        ctx.ui.notify('No conversation to hand off', 'error')
        return
      }

      const conversationText = serializeConversation(convertToLlm(messages))
      const currentSessionFile = ctx.sessionManager.getSessionFile()

      const readHeader = async (file: string): Promise<SessionHeader | null> => {
        try {
          const { stdout } = await pi.exec('head', ['-1', file])
          return JSON.parse(stdout) as SessionHeader
        } catch {
          return null
        }
      }

      const sessionChain = await collectSessionChain(currentSessionFile, readHeader)

      const result = await ctx.ui.custom<{ text: string | null; error?: string }>(
        (tui, theme, _kb, done) => {
          const loader = new BorderedLoader(tui, theme, 'Generating handoff prompt...')
          loader.onAbort = () => done({ text: null })

          const doGenerate = async () => {
            const response = await ctx.modelRegistry.complete(
              ctx.model!,
              {
                systemPrompt: SYSTEM_PROMPT,
                messages: [
                  {
                    role: 'user',
                    content: [
                      {
                        type: 'text',
                        text: `## Conversation History\n\n${conversationText}\n\n## User's Goal for New Thread\n\n${goal}`,
                      },
                    ],
                    timestamp: Date.now(),
                  } satisfies Message,
                ],
              },
              { signal: loader.signal, cacheRetention: 'none', sessionId: uuidv7() },
            )

            if (response.stopReason === 'aborted') return { text: null }
            if (response.stopReason === 'error') {
              return { text: null, error: response.errorMessage || 'Unknown error' }
            }

            const text = response.content
              .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
              .map((c) => c.text)
              .join('\n')

            if (!text) {
              return {
                text: null,
                error: `No text in response. Stop reason: ${response.stopReason}, content types: ${response.content
                  .map((c) => c.type)
                  .join(', ')}`,
              }
            }
            return { text }
          }

          doGenerate().then(done, (err: unknown) =>
            done({ text: null, error: err instanceof Error ? err.message : String(err) }),
          )

          return loader
        },
      )

      if (result.error) {
        ctx.ui.notify(`Handoff failed: ${result.error}`, 'error')
        return
      }
      if (result.text === null) {
        ctx.ui.notify('Cancelled', 'info')
        return
      }

      const editedPrompt = await ctx.ui.editor(
        'Edit handoff prompt',
        result.text + sessionHistorySection(sessionChain),
      )
      if (editedPrompt === undefined) {
        ctx.ui.notify('Cancelled', 'info')
        return
      }

      // ctx is stale after the switch: install the draft from the replacement context.
      const newSessionResult = await ctx.newSession({
        parentSession: currentSessionFile,
        withSession: async (replacementCtx) => {
          replacementCtx.ui.setEditorText(editedPrompt)
          replacementCtx.ui.notify('Handoff ready. Submit when ready.', 'info')
        },
      })

      if (newSessionResult.cancelled) {
        ctx.ui.notify('New session cancelled', 'info')
      }
    },
  })
}
