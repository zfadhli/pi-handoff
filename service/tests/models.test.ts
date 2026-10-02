import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createServiceModels, DEFAULT_PROVIDER, defaultAuthPath, resolveModel } from '../models.ts'

async function fixtureAuthPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'service-models-'))
  const authPath = join(dir, 'auth.json')
  await writeFile(authPath, JSON.stringify({ deepseek: { type: 'api_key', key: 'sk-test' } }))
  return authPath
}

test('defaultAuthPath respects PI_AUTH_FILE', () => {
  const prev = process.env.PI_AUTH_FILE
  try {
    process.env.PI_AUTH_FILE = '/tmp/custom-auth.json'
    assert.equal(defaultAuthPath(), '/tmp/custom-auth.json')
  } finally {
    if (prev === undefined) delete process.env.PI_AUTH_FILE
    else process.env.PI_AUTH_FILE = prev
  }
})

test('defaultAuthPath falls back to ~/.pi/agent/auth.json', () => {
  const prev = process.env.PI_AUTH_FILE
  try {
    delete process.env.PI_AUTH_FILE
    assert.ok(defaultAuthPath().endsWith(join('.pi', 'agent', 'auth.json')))
  } finally {
    if (prev !== undefined) process.env.PI_AUTH_FILE = prev
  }
})

test('resolveModel defaults to the first available opencode-go model', async () => {
  const models = createServiceModels(await fixtureAuthPath())
  const first = models.getModels('opencode-go')[0]
  assert.deepEqual(resolveModel(models), { provider: 'opencode-go', modelId: first.id })
  assert.equal(DEFAULT_PROVIDER, 'opencode-go')
})

test('service models register deepseek and opencode-go', async () => {
  const models = createServiceModels(await fixtureAuthPath())
  const ids = models.getProviders().map((p) => p.id)
  assert.ok(ids.includes('deepseek'))
  assert.ok(ids.includes('opencode-go'))
})

test('resolveModel honors an explicit valid modelId', async () => {
  const models = createServiceModels(await fixtureAuthPath())
  const ids = models.getModels('deepseek').map((m) => m.id)
  assert.ok(ids.length > 0)
  assert.deepEqual(resolveModel(models, 'deepseek', ids[0]), {
    provider: 'deepseek',
    modelId: ids[0],
  })
})

test('resolveModel rejects an invalid modelId with a clear message', async () => {
  const models = createServiceModels(await fixtureAuthPath())
  assert.throws(() => resolveModel(models, 'deepseek', 'no-such-model'), /no-such-model/)
})

test('unknown provider id throws and lists available provider ids', async () => {
  const models = createServiceModels(await fixtureAuthPath())
  assert.throws(() => resolveModel(models, 'nope'), /nope/)
  assert.throws(() => resolveModel(models, 'nope'), /deepseek/)
  assert.throws(() => resolveModel(models, 'nope'), /opencode-go/)
  assert.throws(() => resolveModel(models, 'nope'), /built-in/)
})
