import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { buildSessionContext, readSessionContext } from '../session-context.ts'

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

test('no compaction keeps user, assistant, and toolResult in order', async () => {
  const jsonl = fixture('basic.jsonl')
  assert.deepEqual(buildSessionContext(jsonl), [
    { role: 'user', text: 'Hello' },
    { role: 'assistant', text: 'Hi there' },
    { role: 'toolResult', text: 'result ok' },
  ])
  assert.deepEqual(await readSessionContext(fixturePath('basic.jsonl')), buildSessionContext(jsonl))
})

test('compaction replaces prior messages with the summary plus kept range', () => {
  assert.deepEqual(buildSessionContext(fixture('compaction.jsonl')), [
    {
      role: 'compactionSummary',
      text: 'The conversation history before this point was compacted into the following summary:\n\n<summary>\nearly chat recap\n</summary>',
    },
    { role: 'user', text: 'later question' },
    { role: 'assistant', text: 'later answer' },
  ])
})

test('retain-none compaction keeps only the summary and post-compaction entries', () => {
  assert.deepEqual(buildSessionContext(fixture('retain-none.jsonl')), [
    {
      role: 'compactionSummary',
      text: 'The conversation history before this point was compacted into the following summary:\n\n<summary>\nfull reset\n</summary>',
    },
    { role: 'user', text: 'fresh start' },
    { role: 'assistant', text: 'fresh answer' },
  ])
})

test('pi-written compaction fixture: summary first, kept range, post-compaction after', () => {
  const jsonl = fixture('real-compaction.jsonl')
  const messages = buildSessionContext(jsonl)
  assert.deepEqual(messages, [
    {
      role: 'compactionSummary',
      text: 'The conversation history before this point was compacted into the following summary:\n\n<summary>\nUser asked for two exact-phrase replies; assistant gave both.\n</summary>',
    },
    { role: 'custom', text: 'CHISLE ACTIVE. Terse efficiency rules for this session.' },
    { role: 'assistant', text: 'hello fixture' },
    { role: 'user', text: 'Reply with exactly: second turn done' },
    { role: 'assistant', text: 'second turn done' },
    { role: 'user', text: 'Reply with exactly: after compaction' },
    { role: 'assistant', text: ' \nafter compaction' },
  ])
  assert.ok(!messages.some((m) => m.text.includes('Reply with exactly: hello fixture')))
})

test('string and array content render; image blocks are ignored', () => {
  assert.deepEqual(buildSessionContext(fixture('content-shapes.jsonl')), [
    { role: 'user', text: 'plain string' },
    { role: 'user', text: 'a\nb' },
    { role: 'assistant', text: 'checking\nread' },
    { role: 'toolResult', text: 'file contents' },
  ])
})

test('context edits omit, replace, and latest edit per target wins', () => {
  assert.deepEqual(buildSessionContext(fixture('context-edit.jsonl')), [
    { role: 'user', text: 'latest wins' },
    { role: 'user', text: 'untouched' },
  ])
})

test('branch summary is included as a message; label contributes nothing', () => {
  assert.deepEqual(buildSessionContext(fixture('branch-summary.jsonl')), [
    { role: 'user', text: 'q' },
    {
      role: 'branchSummary',
      text: 'The following is a summary of a branch that this conversation came back from:\n\n<summary>\nbranch recap</summary>',
    },
    { role: 'assistant', text: 'a' },
  ])
})
