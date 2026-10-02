import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SYSTEM_PROMPT } from '../../logic.ts'
import type { SessionContextMessage } from '../session-context.ts'
import { buildGenerationInput, finalizePrompt, serializeMessages } from '../prompt.ts'

test('serializeMessages renders the mixed transcript like pi serializeConversation', () => {
  // pi emits separate [Assistant thinking] / [Assistant] / [Assistant tool calls]
  // parts; tool args render as name(k=JSON). Multi-text user/toolResult content
  // arrives already joined with "" by session-context (pi contentText sep).
  const messages: SessionContextMessage[] = [
    { role: 'user', text: 'Add retries to the fetch call' },
    { role: 'assistantThinking', text: 'Let me check the code.' },
    { role: 'assistant', text: 'Read the file first.' },
    { role: 'assistantToolCalls', text: 'read(path="src/fetch.ts")' },
    { role: 'toolResult', text: 'const x = fetch(url)' },
    { role: 'user', text: 'Ran `ls`\n```\nout\n```' },
    {
      role: 'compactionSummary',
      text: 'The conversation history before this point was compacted into the following summary:\n\n<summary>\nOld work.\n</summary>',
    },
  ]
  assert.equal(
    serializeMessages(messages),
    '[User]: Add retries to the fetch call\n\n' +
      '[Assistant thinking]: Let me check the code.\n\n' +
      '[Assistant]: Read the file first.\n\n' +
      '[Assistant tool calls]: read(path="src/fetch.ts")\n\n' +
      '[Tool result]: const x = fetch(url)\n\n' +
      '[User]: Ran `ls`\n```\nout\n```\n\n' +
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
