import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { runCli } from '../commands.ts'

const BASIC_LINES = [
  '{"type":"message","id":"u1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"Hello"}}',
  '{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Hi there"}]}}',
]

function testModels() {
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  return { faux, models }
}

function capture() {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    stdout,
    stderr,
    deps: {
      stdout: (s: string) => stdout.push(s),
      stderr: (s: string) => stderr.push(s),
    },
  }
}

async function writeSessionFile(
  dir: string,
  name: string,
  parentSession?: string,
): Promise<string> {
  const header = JSON.stringify({
    type: 'session',
    version: 3,
    id: name,
    timestamp: '2026-01-01T00:00:00.000Z',
    cwd: '/repo',
    ...(parentSession === undefined ? {} : { parentSession }),
  })
  const file = join(dir, name)
  await writeFile(file, [header, ...BASIC_LINES].join('\n'))
  return file
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'handoff-commands-'))
  const storePath = join(dir, 'handoff.sqlite')
  return { dir, storePath }
}

test('submit prints the generated text plus a session history section', async () => {
  const { dir, storePath } = await setup()
  const { faux, models } = testModels()
  try {
    const parent = await writeSessionFile(dir, 'parent.jsonl')
    const child = await writeSessionFile(dir, 'child.jsonl', parent)
    faux.setResponses([fauxAssistantMessage('GENERATED PROMPT')])
    const cap = capture()
    const code = await runCli(
      ['submit', '--session', child, '--goal', 'do the thing', '--provider', 'faux'],
      { models, storePath, ...cap.deps },
    )
    assert.equal(code, 0)
    const text = cap.stdout.join('\n')
    assert.match(text, /GENERATED PROMPT/)
    assert.match(text, /## Session History/)
    assert.ok(text.includes(parent), 'history section lists the parent session file')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('submit --detach prints JSON with numeric id and conversationId', async () => {
  const { dir, storePath } = await setup()
  const { faux, models } = testModels()
  try {
    const session = await writeSessionFile(dir, 's.jsonl')
    faux.setResponses([fauxAssistantMessage('DETACHED')])
    const cap = capture()
    const code = await runCli(
      ['submit', '--session', session, '--goal', 'later', '--provider', 'faux', '--detach'],
      { models, storePath, ...cap.deps },
    )
    assert.equal(code, 0)
    const parsed = JSON.parse(cap.stdout.join('\n')) as { id: unknown; conversationId: unknown }
    assert.equal(typeof parsed.id, 'number')
    assert.equal(typeof parsed.conversationId, 'number')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('list shows the submitted item as done with the goal', async () => {
  const { dir, storePath } = await setup()
  const { faux, models } = testModels()
  try {
    const session = await writeSessionFile(dir, 's.jsonl')
    faux.setResponses([fauxAssistantMessage('LIST TEXT')])
    const submitCap = capture()
    const submitCode = await runCli(
      ['submit', '--session', session, '--goal', 'list-goal-123', '--provider', 'faux'],
      { models, storePath, ...submitCap.deps },
    )
    assert.equal(submitCode, 0)
    const listCap = capture()
    const listCode = await runCli(['list'], { models, storePath, ...listCap.deps })
    assert.equal(listCode, 0)
    const rows = listCap.stdout.join('\n')
    assert.match(rows, /done/)
    assert.ok(rows.includes('list-goal-123'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('result prints the text; unknown id exits 2', async () => {
  const { dir, storePath } = await setup()
  const { faux, models } = testModels()
  try {
    const session = await writeSessionFile(dir, 's.jsonl')
    faux.setResponses([fauxAssistantMessage('RESULT TEXT')])
    const detachCap = capture()
    const detachCode = await runCli(
      ['submit', '--session', session, '--goal', 'fetch me', '--provider', 'faux', '--detach'],
      { models, storePath, ...detachCap.deps },
    )
    assert.equal(detachCode, 0)
    const { conversationId } = JSON.parse(detachCap.stdout.join('\n')) as {
      conversationId: number
    }

    const resumeCap = capture()
    const resumeCode = await runCli(['resume'], { models, storePath, ...resumeCap.deps })
    assert.equal(resumeCode, 0)

    const cap = capture()
    const code = await runCli([`result`, `${conversationId}`], {
      models,
      storePath,
      ...cap.deps,
    })
    const text = cap.stdout.join('\n')
    assert.equal(code, 0)
    assert.match(text, /RESULT TEXT/)

    const unknownCap = capture()
    const unknownCode = await runCli(['result', '999999'], {
      models,
      storePath,
      ...unknownCap.deps,
    })
    assert.equal(unknownCode, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('submit without --session exits 1 with a message', async () => {
  const { storePath } = await setup()
  const { models } = testModels()
  try {
    const cap = capture()
    const code = await runCli(['submit', '--goal', 'nope'], {
      models,
      storePath,
      ...cap.deps,
    })
    assert.equal(code, 1)
    assert.ok(cap.stderr.join('\n').length > 0, 'expected an error message on stderr')
  } finally {
    // temp dir left for the sqlite file; nothing to clean beyond best effort
  }
})

test('--help exits 0 and lists submit, result, list, resume', async () => {
  const { models } = testModels()
  const cap = capture()
  const code = await runCli(['--help'], { models, ...cap.deps })
  assert.equal(code, 0)
  const help = cap.stdout.join('\n')
  for (const command of ['submit', 'result', 'list', 'resume']) {
    assert.ok(help.includes(command), `help lists ${command}`)
  }
})

test('session fixture helper writes a readable header', async () => {
  const { dir } = await setup()
  try {
    const file = await writeSessionFile(dir, 'hdr.jsonl')
    const header = JSON.parse((await readFile(file, 'utf8')).split('\n')[0] ?? '{}') as {
      type: string
    }
    assert.equal(header.type, 'session')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('submit unanswered prints reason and detail on stderr', async () => {
  const { dir, storePath } = await setup()
  const { faux, models } = testModels()
  try {
    faux.setResponses([
      () => {
        throw new Error('SUBMIT BOOM DETAIL')
      },
    ])
    const session = await writeSessionFile(dir, 's.jsonl')
    const cap = capture()
    const code = await runCli(
      ['submit', '--session', session, '--goal', 'failing goal', '--provider', 'faux'],
      { models, storePath, ...cap.deps },
    )
    assert.equal(code, 1)
    const errText = cap.stderr.join('\n')
    assert.ok(errText.includes('model_error'), 'stderr prints the reason')
    assert.ok(errText.includes('SUBMIT BOOM DETAIL'), 'stderr prints the detail')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('result unanswered prints reason and detail on stderr', async () => {
  const { dir, storePath } = await setup()
  const { faux, models } = testModels()
  try {
    faux.setResponses([
      () => {
        throw new Error('RESULT BOOM DETAIL')
      },
    ])
    const session = await writeSessionFile(dir, 's.jsonl')
    const detachCap = capture()
    const detachCode = await runCli(
      [
        'submit',
        '--session',
        session,
        '--goal',
        'failing detach',
        '--provider',
        'faux',
        '--detach',
      ],
      { models, storePath, ...detachCap.deps },
    )
    assert.equal(detachCode, 0)
    const { conversationId } = JSON.parse(detachCap.stdout.join('\n')) as {
      conversationId: number
    }
    const resumeCap = capture()
    const resumeCode = await runCli(['resume'], { models, storePath, ...resumeCap.deps })
    assert.equal(resumeCode, 0)
    const cap = capture()
    const code = await runCli(['result', `${conversationId}`], {
      models,
      storePath,
      ...cap.deps,
    })
    assert.equal(code, 1)
    const errText = cap.stderr.join('\n')
    assert.ok(errText.includes('model_error'), 'stderr prints the reason')
    assert.ok(errText.includes('RESULT BOOM DETAIL'), 'stderr prints the detail')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('result <id> -h still executes result instead of printing help', async () => {
  const { dir, storePath } = await setup()
  const { faux, models } = testModels()
  try {
    const session = await writeSessionFile(dir, 's.jsonl')
    faux.setResponses([fauxAssistantMessage('DASH H TEXT')])
    const detachCap = capture()
    const detachCode = await runCli(
      ['submit', '--session', session, '--goal', 'dash h', '--provider', 'faux', '--detach'],
      { models, storePath, ...detachCap.deps },
    )
    assert.equal(detachCode, 0)
    const { conversationId } = JSON.parse(detachCap.stdout.join('\n')) as {
      conversationId: number
    }
    const resumeCap = capture()
    assert.equal(await runCli(['resume'], { models, storePath, ...resumeCap.deps }), 0)
    const cap = capture()
    const code = await runCli(['result', `${conversationId}`, '-h'], {
      models,
      storePath,
      ...cap.deps,
    })
    assert.equal(code, 0)
    assert.match(cap.stdout.join('\n'), /DASH H TEXT/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
