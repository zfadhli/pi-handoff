import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  type FauxResponseFactory,
} from '@earendil-works/pi-ai/providers/faux'
import { buildHandoffSettings, HandoffStore, OPENCODE_SESSION_HEADER } from '../store.ts'

const ctx = BACKGROUND_CONTEXT

async function tempStorePath(): Promise<{ dir: string; storePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'handoff-store-'))
  return { dir, storePath: join(dir, 'handoff.sqlite') }
}

function testModels() {
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const model = { provider: faux.provider.id, modelId: faux.getModel().id }
  return { faux, models, model }
}

test('submit + wait returns the scripted text', async () => {
  const { dir, storePath } = await tempStorePath()
  const { faux, models, model } = testModels()
  try {
    faux.setResponses([fauxAssistantMessage('HANDOFF TEXT')])
    const store = await HandoffStore.open({ models, storePath })
    try {
      const { id } = await store.submit({ requestId: 'req-1', content: 'make handoff', model })
      const result = await store.wait(id)
      assert.equal(result.status, 'done')
      assert.equal(result.status === 'done' ? result.text : undefined, 'HANDOFF TEXT')
    } finally {
      await store.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('same requestId submitted twice returns the same submission id', async () => {
  const { dir, storePath } = await tempStorePath()
  const { faux, models, model } = testModels()
  try {
    faux.setResponses([fauxAssistantMessage('ONLY ANSWER')])
    const store = await HandoffStore.open({ models, storePath })
    try {
      const first = await store.submit({ requestId: 'dup', content: 'make handoff', model })
      const second = await store.submit({ requestId: 'dup', content: 'make handoff', model })
      assert.equal(second.id, first.id)
      assert.equal(second.conversationId, first.conversationId)
      const page = await store.harness.commit((tx) => tx.scanConversations({}, 100), ctx)
      assert.equal(page.items.length, 1)
      const result = await store.wait(first.id)
      assert.equal(result.status, 'done')
      assert.equal(result.status === 'done' ? result.text : undefined, 'ONLY ANSWER')
    } finally {
      await store.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('different requestIds get different submission ids and conversations', async () => {
  const { dir, storePath } = await tempStorePath()
  const { faux, models, model } = testModels()
  try {
    faux.setResponses([fauxAssistantMessage('ONE'), fauxAssistantMessage('TWO')])
    const store = await HandoffStore.open({ models, storePath })
    try {
      const first = await store.submit({ requestId: 'req-a', content: 'first', model })
      const second = await store.submit({ requestId: 'req-b', content: 'second', model })
      assert.notEqual(second.id, first.id)
      assert.notEqual(second.conversationId, first.conversationId)
      const page = await store.harness.commit((tx) => tx.scanConversations({}, 100), ctx)
      assert.equal(page.items.length, 2)
    } finally {
      await store.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('close + reopen + resume reacquires the submission by id', async () => {
  const { dir, storePath } = await tempStorePath()
  const { faux, models, model } = testModels()
  try {
    faux.setResponses([fauxAssistantMessage('REOPENED TEXT')])
    const store = await HandoffStore.open({ models, storePath })
    const { id } = await store.submit({ requestId: 'req-reopen', content: 'make handoff', model })
    await store.close()

    const reopened = await HandoffStore.open({ models, storePath })
    try {
      await reopened.resume()
      const reacquired = await reopened.harness.submission(id, ctx)
      assert.notEqual(reacquired, undefined)
      const result = await reopened.wait(id)
      assert.equal(result.status, 'done')
      assert.equal(result.status === 'done' ? result.text : undefined, 'REOPENED TEXT')
    } finally {
      await reopened.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('buildHandoffSettings supplies the x-opencode-session header', () => {
  const settings = buildHandoffSettings('sess-1')
  assert.equal(settings.stream.headers?.[OPENCODE_SESSION_HEADER], 'sess-1')
})

test('open assigns a session id when none is injected', async () => {
  const { dir, storePath } = await tempStorePath()
  const { models } = testModels()
  try {
    const first = await HandoffStore.open({ models, storePath })
    try {
      assert.ok(first.sessionId.length > 0)
    } finally {
      await first.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('generation forwards the x-opencode-session header to the provider', async () => {
  const { dir, storePath } = await tempStorePath()
  const { faux, models, model } = testModels()
  try {
    let seen: Record<string, string | null> | undefined
    const capture: FauxResponseFactory = (_context, options) => {
      seen = options?.headers
      return fauxAssistantMessage('HI')
    }
    faux.setResponses([capture])
    const store = await HandoffStore.open({ models, storePath, sessionId: 'test-session-123' })
    try {
      const { id } = await store.submit({ requestId: 'req-headers', content: 'x', model })
      const result = await store.wait(id)
      assert.equal(result.status, 'done')
      assert.equal(seen?.[OPENCODE_SESSION_HEADER], 'test-session-123')
    } finally {
      await store.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('wait surfaces detail when the durable submission carries it', async () => {
  const { dir, storePath } = await tempStorePath()
  const { faux, models, model } = testModels()
  try {
    const failing: FauxResponseFactory = () => {
      throw new Error('BOOM DETAIL MESSAGE')
    }
    faux.setResponses([failing])
    const store = await HandoffStore.open({ models, storePath })
    try {
      const { id, conversationId } = await store.submit({
        requestId: 'req-detail',
        content: 'x',
        model,
        meta: { sessionFile: 'detail.md', goal: 'detail goal' },
      })
      const waited = await store.wait(id)
      assert.equal(waited.status, 'unanswered')
      assert.equal(waited.status === 'unanswered' ? waited.reason : undefined, 'model_error')
      assert.ok(
        (waited.status === 'unanswered' ? waited.detail : undefined)?.includes(
          'BOOM DETAIL MESSAGE',
        ),
      )
      const result = await store.result(conversationId)
      assert.equal(result.status, 'unanswered')
      assert.equal(result.status === 'unanswered' ? result.reason : undefined, 'model_error')
      assert.ok(
        (result.status === 'unanswered' ? result.detail : undefined)?.includes(
          'BOOM DETAIL MESSAGE',
        ),
      )
    } finally {
      await store.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
