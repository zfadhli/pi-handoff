import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SYSTEM_PROMPT } from '../../logic.ts'
import type { SessionContextMessage } from '../session-context.ts'
import { buildGenerationInput, finalizePrompt, serializeMessages } from '../prompt.ts'

test('serializeMessages renders the mixed transcript like pi serializeConversation', () => {
  // Assistant text mirrors service/session-context.ts renderContent: text blocks
  // joined with "\n", plus thinking text and toolCall names.
  const messages: SessionContextMessage[] = [
    { role: 'user', text: 'Add retries to the fetch call' },
    { role: 'assistant', text: 'Let me check the code.\nRead the file first.\nread' },
    { role: 'toolResult', text: 'const x = fetch(url)' },
    {
      role: 'compactionSummary',
      text: 'The conversation history before this point was compacted into the following summary:\n\n<summary>\nOld work.\n</summary>',
    },
  ]
  assert.equal(
    serializeMessages(messages),
    '[User]: Add retries to the fetch call\n\n' +
      '[Assistant]: Let me check the code.\nRead the file first.\nread\n\n' +
      '[Tool result]: const x = fetch(url)\n\n' +
      '[User]: The conversation history before this point was compacted into the following summary:\n\n<summary>\nOld work.\n</summary>',
  )
})

test('buildGenerationInput matches the extension inline template', () => {
  const { systemPrompt, userContent } = buildGenerationInput('Ship it', 'CONV')
  assert.equal(systemPrompt, SYSTEM_PROMPT)
  assert.equal(
    userContent,
    "## Conversation History\n\nCONV\n\n## User's Goal for New Thread\n\nShip it",
  )
})

test('finalizePrompt concatenates generated text and session section', () => {
  assert.equal(
    finalizePrompt('PROMPT', '\n\n## Session History\n...'),
    'PROMPT\n\n## Session History\n...',
  )
})
