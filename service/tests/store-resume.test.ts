import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationId } from '@earendil-works/pi-durable'
import { HandoffStore } from '../store.ts'

const ctx = BACKGROUND_CONTEXT

async function tempStorePath(): Promise<{ dir: string; storePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'handoff-store-resume-'))
  return { dir, storePath: join(dir, 'handoff.sqlite') }
}

function testModels() {
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const model = { provider: faux.provider.id, modelId: faux.getModel().id }
  return { faux, models, model }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForDone(store: HandoffStore, conversationId: ConversationId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const result = await store.result(conversationId)
    if (result.status !== 'pending') return result
    assert.ok(Date.now() < deadline, 'timed out waiting for conversation to settle')
    await sleep(50)
  }
}

test('submit with meta → list returns the item, done after wait', async () => {
  const { dir, storePath } = await tempStorePath()
  const { faux, models, model } = testModels()
  try {
    faux.setResponses([fauxAssistantMessage('META TEXT')])
    const store = await HandoffStore.open({ models, storePath })
    try {
      const { id, conversationId } = await store.submit({
        requestId: 'req-meta',
        content: 'make handoff',
        model,
        meta: { sessionFile: 'session-1.md', goal: 'ship it' },
      })
      const items = await store.list()
      assert.equal(items.length, 1)
      assert.equal(items[0]?.conversationId, conversationId)
      assert.equal(items[0]?.sessionFile, 'session-1.md')
      assert.equal(items[0]?.goal, 'ship it')
      const result = await store.wait(id)
      assert.equal(result.status, 'done')
      const after = await store.list()
      assert.equal(after[0]?.status, 'done')
    } finally {
      await store.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('result returns the scripted text', async () => {
  const { dir, storePath } = await tempStorePath()
  const { faux, models, model } = testModels()
  try {
    faux.setResponses([fauxAssistantMessage('RESULT TEXT')])
    const store = await HandoffStore.open({ models, storePath })
    try {
      const { id, conversationId } = await store.submit({
        requestId: 'req-result',
        content: 'make handoff',
        model,
        meta: { sessionFile: 's.md', goal: 'g' },
      })
      const waited = await store.wait(id)
      assert.equal(waited.status, 'done')
      const result = await store.result(conversationId)
      assert.equal(result.status, 'done')
      assert.equal(result.status === 'done' ? result.text : undefined, 'RESULT TEXT')
    } finally {
      await store.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('close → reopen → resume keeps metadata and text', async () => {
  const { dir, storePath } = await tempStorePath()
  const { faux, models, model } = testModels()
  try {
    faux.setResponses([fauxAssistantMessage('PERSISTED TEXT')])
    const store = await HandoffStore.open({ models, storePath })
    const { conversationId } = await store.submit({
      requestId: 'req-persist',
      content: 'make handoff',
      model,
      meta: { sessionFile: 'persist.md', goal: 'persist goal' },
    })
    await store.close()

    const reopened = await HandoffStore.open({ models, storePath })
    try {
      await reopened.resume()
      const result = await waitForDone(reopened, conversationId)
      assert.equal(result.status, 'done')
      assert.equal(result.status === 'done' ? result.text : undefined, 'PERSISTED TEXT')
      const items = await reopened.list()
      assert.equal(items.length, 1)
      assert.equal(items[0]?.conversationId, conversationId)
      assert.equal(items[0]?.sessionFile, 'persist.md')
      assert.equal(items[0]?.goal, 'persist goal')
      assert.equal(items[0]?.status, 'done')
    } finally {
      await reopened.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('invalid model settles unanswered in list and result', async () => {
  const { dir, storePath } = await tempStorePath()
  const { models } = testModels()
  try {
    const store = await HandoffStore.open({ models, storePath })
    try {
      const { id, conversationId } = await store.submit({
        requestId: 'req-bad-model',
        content: 'make handoff',
        model: { provider: 'nope', modelId: 'nope' },
        meta: { sessionFile: 'bad.md', goal: 'bad goal' },
      })
      const waited = await store.wait(id)
      assert.equal(waited.status, 'unanswered')
      const reason = waited.status === 'unanswered' ? waited.reason : undefined
      assert.ok(typeof reason === 'string' && reason.length > 0, 'expected a reason')

      const items = await store.list()
      assert.equal(items.length, 1)
      assert.equal(items[0]?.status, 'unanswered')

      const result = await store.result(conversationId)
      assert.equal(result.status, 'unanswered')
      assert.equal(result.status === 'unanswered' ? result.reason : undefined, reason)
    } finally {
      await store.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('unknown conversationId → result is pending', async () => {
  const { dir, storePath } = await tempStorePath()
  const { models } = testModels()
  try {
    const store = await HandoffStore.open({ models, storePath })
    try {
      const result = await store.result(999999 as ConversationId)
      assert.equal(result.status, 'pending')
    } finally {
      await store.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('list pages through all conversations with a small page size', async () => {
  const { dir, storePath } = await tempStorePath()
  const { faux, models, model } = testModels()
  try {
    faux.setResponses([
      fauxAssistantMessage('P1'),
      fauxAssistantMessage('P2'),
      fauxAssistantMessage('P3'),
    ])
    const store = await HandoffStore.open({ models, storePath, scanPageSize: 1 })
    try {
      for (const n of ['page-a', 'page-b', 'page-c']) {
        const { id } = await store.submit({
          requestId: n,
          content: n,
          model,
          meta: { sessionFile: `${n}.md`, goal: `goal ${n}` },
        })
        await store.wait(id)
      }
      const items = await store.list()
      assert.equal(items.length, 3)
      assert.deepEqual(items.map((item) => item.goal).sort(), [
        'goal page-a',
        'goal page-b',
        'goal page-c',
      ])
    } finally {
      await store.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
