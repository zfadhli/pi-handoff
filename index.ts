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
import { SYSTEM_PROMPT, collectSessionChain, sessionHistorySection } from './logic.js'

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

      pi.appendEntry('handoff', { goal, prompt: editedPrompt })

      // ctx is stale after the switch: post-switch UI work runs in withSession.
      const newSessionResult = await ctx.newSession({
        parentSession: currentSessionFile,
        setup: async (sessionManager) => {
          sessionManager.appendCustomMessageEntry('handoff', editedPrompt, true, { goal })
        },
        withSession: async (replacementCtx) => {
          replacementCtx.ui.notify('Handoff ready. Type your next instruction.', 'info')
        },
      })

      if (newSessionResult.cancelled) {
        ctx.ui.notify('New session cancelled', 'info')
      }
    },
  })
}
