import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionHeader } from '@earendil-works/pi-coding-agent'
import { buildHandoffSession, collectSessionChain, sessionHistorySection } from '../logic.ts'

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

test('setup appends the handoff prompt with goal metadata', async () => {
  const built = buildHandoffSession({
    parentSession: '/s/current.jsonl',
    goal: 'ship it',
    prompt: 'draft',
  })
  assert.ok(built.setup)
  const calls: unknown[][] = []
  const fakeSessionManager = {
    appendCustomMessageEntry: (...args: unknown[]) => {
      calls.push(args)
      return 'entry-id'
    },
  }
  await built.setup(fakeSessionManager as never)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ['handoff', 'draft', true, { goal: 'ship it' }])
})

test('withSession notifies once and touches nothing else', async () => {
  const built = buildHandoffSession({
    parentSession: '/s/current.jsonl',
    goal: 'ship it',
    prompt: 'draft',
  })
  assert.ok(built.withSession)
  const notifyCalls: unknown[][] = []
  const touched: string[] = []
  const fakeUi = new Proxy(
    {
      notify: (...args: unknown[]) => {
        notifyCalls.push(args)
      },
    },
    {
      get(target, prop, receiver) {
        touched.push(`ui.${String(prop)}`)
        return Reflect.get(target, prop, receiver)
      },
    },
  )
  const fakeCtx = new Proxy(
    { ui: fakeUi },
    {
      get(target, prop, receiver) {
        touched.push(String(prop))
        return Reflect.get(target, prop, receiver)
      },
    },
  )
  await built.withSession(fakeCtx as never)
  assert.equal(notifyCalls.length, 1)
  assert.deepEqual(notifyCalls[0], ['Handoff ready. Type your next instruction.', 'info'])
  assert.deepEqual(touched, ['ui', 'ui.notify'])
  assert.ok(!touched.some((t) => t.includes('setEditorText')))
})

test('parentSession passes through unchanged', () => {
  assert.equal(
    buildHandoffSession({ parentSession: '/s/current.jsonl', goal: 'g', prompt: 'p' })
      .parentSession,
    '/s/current.jsonl',
  )
  assert.equal(
    buildHandoffSession({ parentSession: undefined, goal: 'g', prompt: 'p' }).parentSession,
    undefined,
  )
})
