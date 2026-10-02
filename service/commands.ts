import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { MutableModels } from '@earendil-works/pi-ai/models'
import type { ConversationId } from '@earendil-works/pi-durable'
import { collectSessionChain, sessionHistorySection } from '../logic.ts'
import { createServiceModels, resolveModel } from './models.ts'
import { buildGenerationInput, finalizePrompt, serializeMessages } from './prompt.ts'
import { readSessionContext } from './session-context.ts'
import { HandoffStore } from './store.ts'

export type CliDeps = {
  models?: MutableModels
  storePath?: string
  stdout?: (text: string) => void
  stderr?: (text: string) => void
}

const USAGE = `Usage: pi-handoff <command> [options]

Commands:
  submit --session <file> --goal <text> [--provider <id>] [--model <id>] [--store <path>] [--detach] [--json]
  result <conversationId> [--store <path>]
  list [--store <path>] [--json]
  resume [--store <path>]

Options:
  --help, -h   Show this help`

const VALUE_FLAGS = new Set(['--session', '--goal', '--provider', '--model', '--store'])
const BOOL_FLAGS = new Set(['--detach', '--json'])

function parseArgs(args: string[]): { flags: Map<string, string | true>; positionals: string[] } {
  const flags = new Map<string, string | true>()
  const positionals: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg : arg.slice(0, eq)
    const inline = eq === -1 ? undefined : arg.slice(eq + 1)
    if (name === '--help' || name === '-h') {
      flags.set('--help', true)
      continue
    }
    if (VALUE_FLAGS.has(name)) {
      const value = inline ?? args[++i]
      if (value === undefined || value.startsWith('--'))
        throw new Error(`missing value for ${name}`)
      flags.set(name, value)
      continue
    }
    if (BOOL_FLAGS.has(name)) {
      if (inline !== undefined) throw new Error(`flag ${name} takes no value`)
      flags.set(name, true)
      continue
    }
    if (arg.startsWith('--')) throw new Error(`unknown flag '${arg}'`)
    positionals.push(arg)
  }
  return { flags, positionals }
}

function expandStorePath(path: string): string {
  if (path === '~' || path.startsWith('~/')) return join(homedir(), path.slice(1))
  return path
}

function defaultStorePath(): string {
  return join(homedir(), '.pi', 'agent', 'handoff.sqlite')
}

function resolveStorePath(flags: Map<string, string | true>, deps: CliDeps): string {
  const flag = flags.get('--store')
  if (typeof flag === 'string') return expandStorePath(flag)
  if (deps.storePath !== undefined) return deps.storePath
  return defaultStorePath()
}

async function readHeader(file: string): Promise<{ parentSession?: string } | null> {
  try {
    const first = (await readFile(file, 'utf8')).split('\n')[0] ?? ''
    if (first.trim() === '') return null
    return JSON.parse(first) as { parentSession?: string }
  } catch {
    return null
  }
}

async function runSubmit(
  args: string[],
  deps: CliDeps,
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const { flags } = parseArgs(args)
  const sessionFile = flags.get('--session')
  const goal = flags.get('--goal')
  if (typeof sessionFile !== 'string') throw new Error('missing required flag --session <file>')
  if (typeof goal !== 'string') throw new Error('missing required flag --goal <text>')
  const resolvedSession = resolve(sessionFile)
  const transcript = serializeMessages(await readSessionContext(resolvedSession))
  const { systemPrompt, userContent } = buildGenerationInput(goal, transcript)
  const requestId = createHash('sha256').update(`${resolvedSession}\n${goal}`).digest('hex')
  const models = deps.models ?? createServiceModels()
  const provider = flags.get('--provider')
  const modelId = flags.get('--model')
  const model = resolveModel(
    models,
    typeof provider === 'string' ? provider : undefined,
    typeof modelId === 'string' ? modelId : undefined,
  )
  const store = await HandoffStore.open({ models, storePath: resolveStorePath(flags, deps) })
  try {
    const { id, conversationId } = await store.submit({
      requestId,
      content: userContent,
      instructions: systemPrompt,
      model,
      meta: { sessionFile: resolvedSession, goal },
    })
    if (flags.has('--detach')) {
      out(JSON.stringify({ id, conversationId }))
      return 0
    }
    const settled = await store.wait(id)
    if (settled.status === 'unanswered') {
      err(settled.reason)
      if (settled.detail) err(settled.detail)
      return 1
    }
    const chain = await collectSessionChain(resolvedSession, readHeader)
    const prompt = finalizePrompt(settled.text, sessionHistorySection(chain))
    out(flags.has('--json') ? JSON.stringify({ id, conversationId, text: prompt }) : prompt)
    return 0
  } finally {
    await store.close()
  }
}

async function runResult(
  args: string[],
  deps: CliDeps,
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const { flags, positionals } = parseArgs(args)
  if (positionals.length === 0) throw new Error('missing <conversationId>')
  const raw = positionals[0] as string
  const parsed = Number(raw)
  if (!Number.isInteger(parsed)) {
    err(`pi-handoff: unknown conversation '${raw}'`)
    return 2
  }
  const models = deps.models ?? createServiceModels()
  const store = await HandoffStore.open({ models, storePath: resolveStorePath(flags, deps) })
  try {
    const result = await store.result(parsed as ConversationId)
    if (result.status === 'done') {
      out(result.text)
      return 0
    }
    if (result.status === 'unanswered') {
      err(result.reason)
      if (result.detail) err(result.detail)
      return 1
    }
    err(`pi-handoff: conversation ${parsed} is pending or unknown`)
    return 2
  } finally {
    await store.close()
  }
}

async function printList(
  flags: Map<string, string | true>,
  deps: CliDeps,
  out: (text: string) => void,
  open: () => Promise<HandoffStore>,
): Promise<void> {
  const store = await open()
  try {
    const items = await store.list()
    if (flags.has('--json')) {
      out(JSON.stringify(items))
      return
    }
    for (const item of items) out(`${item.conversationId}\t${item.status}\t${item.goal}`)
  } finally {
    await store.close()
  }
}

async function runResume(
  args: string[],
  deps: CliDeps,
  out: (text: string) => void,
): Promise<number> {
  const { flags } = parseArgs(args)
  const models = deps.models ?? createServiceModels()
  const storePath = resolveStorePath(flags, deps)
  const store = await HandoffStore.open({ models, storePath })
  try {
    await store.resume()
    await store.waitForIdle()
    const items = await store.list()
    if (flags.has('--json')) {
      out(JSON.stringify(items))
      return 0
    }
    for (const item of items) out(`${item.conversationId}\t${item.status}\t${item.goal}`)
    return 0
  } finally {
    await store.close()
  }
}

export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.stdout ?? ((s: string) => process.stdout.write(`${s}\n`))
  const err = deps.stderr ?? ((s: string) => process.stderr.write(`${s}\n`))
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    out(USAGE)
    return 0
  }
  const [command, ...rest] = argv as [string, ...string[]]
  try {
    switch (command) {
      case 'submit':
        return await runSubmit(rest, deps, out, err)
      case 'result':
        return await runResult(rest, deps, out, err)
      case 'list': {
        const { flags } = parseArgs(rest)
        const models = deps.models ?? createServiceModels()
        const storePath = resolveStorePath(flags, deps)
        await printList(flags, deps, out, () => HandoffStore.open({ models, storePath }))
        return 0
      }
      case 'resume':
        return await runResume(rest, deps, out)
      default:
        err(`pi-handoff: unknown command '${command}'`)
        err(USAGE)
        return 1
    }
  } catch (error) {
    err(`pi-handoff: ${error instanceof Error ? error.message : String(error)}`)
    if (
      error instanceof Error &&
      (/^(missing|unknown)/.test(error.message) || error.message.includes('required flag'))
    ) {
      err(USAGE)
    }
    return 1
  }
}
