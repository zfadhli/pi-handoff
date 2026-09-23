import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionHeader } from '@earendil-works/pi-coding-agent'
import { collectSessionChain, sessionHistorySection } from '../logic.ts'

test('session chain walks ancestors, newest first, and survives cycles', async () => {
  const headers: Record<string, SessionHeader | undefined> = {
    '/s/3.jsonl': {
      type: 'session',
      id: '3',
      timestamp: '',
      cwd: '/',
      parentSession: '/s/2.jsonl',
    },
    '/s/2.jsonl': {
      type: 'session',
      id: '2',
      timestamp: '',
      cwd: '/',
      parentSession: '/s/1.jsonl',
    },
    '/s/1.jsonl': {
      type: 'session',
      id: '1',
      timestamp: '',
      cwd: '/',
      parentSession: '/s/3.jsonl',
    },
  }
  const readHeader = async (file: string) => headers[file] ?? null
  assert.deepEqual(await collectSessionChain('/s/3.jsonl', readHeader), [
    '/s/3.jsonl',
    '/s/2.jsonl',
    '/s/1.jsonl',
  ])
  assert.deepEqual(await collectSessionChain(undefined, readHeader), [])
})

test('history section is empty without a chain and lists paths otherwise', () => {
  assert.equal(sessionHistorySection([]), '')
  const section = sessionHistorySection(['/s/2.jsonl', '/s/1.jsonl'])
  assert.match(section, /1\. \/s\/2\.jsonl/)
  assert.match(section, /pi --session <path>/)
})
