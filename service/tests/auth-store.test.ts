import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { JsonFileCredentialStore } from '../auth-store.ts'

async function tempAuthPath(sub = ''): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'auth-store-'))
  return join(dir, sub, 'auth.json')
}

test('missing file reads undefined and lists empty', async () => {
  const authPath = await tempAuthPath()
  const store = new JsonFileCredentialStore(authPath)
  assert.equal(await store.read('deepseek'), undefined)
  assert.deepEqual(await store.list(), [])
  await store.delete('deepseek')
  await assert.rejects(readFile(authPath))
})

test('reads fixture credential and lists metadata without secrets', async () => {
  const authPath = await tempAuthPath()
  await writeFile(authPath, JSON.stringify({ deepseek: { type: 'api_key', key: 'sk-test' } }))
  const store = new JsonFileCredentialStore(authPath)
  assert.deepEqual(await store.read('deepseek'), { type: 'api_key', key: 'sk-test' })
  assert.deepEqual(await store.list(), [{ providerId: 'deepseek', type: 'api_key' }])
})

test('modify adds a provider and preserves existing entries on disk', async () => {
  const authPath = await tempAuthPath()
  await writeFile(authPath, JSON.stringify({ deepseek: { type: 'api_key', key: 'sk-test' } }))
  const store = new JsonFileCredentialStore(authPath)
  await store.modify('openai', async () => ({ type: 'api_key' as const, key: 'sk-openai' }))
  const reloaded = new JsonFileCredentialStore(authPath)
  assert.deepEqual(await reloaded.read('openai'), { type: 'api_key', key: 'sk-openai' })
  assert.deepEqual(await reloaded.read('deepseek'), { type: 'api_key', key: 'sk-test' })
})

test('modify returning undefined leaves the file unchanged', async () => {
  const authPath = await tempAuthPath()
  const fixture = JSON.stringify({ deepseek: { type: 'api_key', key: 'sk-test' } })
  await writeFile(authPath, fixture)
  const store = new JsonFileCredentialStore(authPath)
  const current = await store.modify('deepseek', async () => undefined)
  assert.deepEqual(current, { type: 'api_key', key: 'sk-test' })
  assert.equal(await readFile(authPath, 'utf8'), fixture)
})

test('delete removes only the target entry', async () => {
  const authPath = await tempAuthPath()
  await writeFile(
    authPath,
    JSON.stringify({
      deepseek: { type: 'api_key', key: 'sk-test' },
      openai: { type: 'api_key', key: 'sk-openai' },
    }),
  )
  const store = new JsonFileCredentialStore(authPath)
  await store.delete('openai')
  assert.equal(await store.read('openai'), undefined)
  assert.deepEqual(await store.read('deepseek'), { type: 'api_key', key: 'sk-test' })
  assert.deepEqual(await store.list(), [{ providerId: 'deepseek', type: 'api_key' }])
  await store.delete('absent')
  assert.deepEqual(await store.read('deepseek'), { type: 'api_key', key: 'sk-test' })
})

test('concurrent modifies for different providers both persist', async () => {
  const authPath = await tempAuthPath('nested')
  const store = new JsonFileCredentialStore(authPath)
  await Promise.all([
    store.modify('openai', async () => ({ type: 'api_key' as const, key: 'sk-openai' })),
    store.modify('deepseek', async () => ({ type: 'api_key' as const, key: 'sk-test' })),
  ])
  const reloaded = new JsonFileCredentialStore(authPath)
  assert.deepEqual(await reloaded.read('openai'), { type: 'api_key', key: 'sk-openai' })
  assert.deepEqual(await reloaded.read('deepseek'), { type: 'api_key', key: 'sk-test' })
})

test('written file has mode 0o600', { skip: process.platform === 'win32' }, async () => {
  const authPath = await tempAuthPath()
  const store = new JsonFileCredentialStore(authPath)
  await store.modify('deepseek', async () => ({ type: 'api_key' as const, key: 'sk-test' }))
  assert.equal((await stat(authPath)).mode & 0o777, 0o600)
})

test('malformed JSON causes read to reject', async () => {
  const authPath = await tempAuthPath()
  await writeFile(authPath, '{not json')
  const store = new JsonFileCredentialStore(authPath)
  await assert.rejects(store.read('deepseek'))
})
