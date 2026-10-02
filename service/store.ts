import type { Context } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { MutableModels } from '@earendil-works/pi-ai/models'
import { randomUUID } from 'node:crypto'
import {
  AssistantEntry,
  createRegistry,
  defineEntry,
  Harness,
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type ConversationRecord,
  type Cursor,
  type SubmissionId,
  type SubmissionRecord,
} from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'

export type HandoffModel = {
  readonly provider: string
  readonly modelId: string
}

export type HandoffMeta = {
  readonly sessionFile: string
  readonly goal: string
}

export type HandoffSubmitRequest = {
  readonly requestId: string
  readonly content: string
  readonly instructions?: string
  readonly model: HandoffModel
  readonly meta?: HandoffMeta
}

export type HandoffResult =
  | { status: 'done'; text: string }
  | { status: 'unanswered'; reason: string; detail?: string }

export type HandoffListItem = {
  readonly conversationId: ConversationId
  readonly status: 'pending' | 'done' | 'unanswered'
  readonly sessionFile: string
  readonly goal: string
  readonly createdAt?: number
}

export type HandoffConversationResult = HandoffResult | { status: 'pending' }

type HandoffRequestData = {
  readonly sessionFile: string
  readonly goal: string
  readonly createdAt: number
  readonly requestId: string
}

export const OPENCODE_SESSION_HEADER = 'x-opencode-session'

export function buildHandoffSettings(sessionId: string): {
  stream: { headers: Record<string, string> }
} {
  return { stream: { headers: { [OPENCODE_SESSION_HEADER]: sessionId } } }
}

function formatDetail(detail: unknown): string | undefined {
  if (detail === undefined || detail === null) return undefined
  if (typeof detail === 'string') return detail
  return JSON.stringify(detail)
}

const RequestEntry = defineEntry<HandoffRequestData>('handoff.request')

function renderAssistantText(model: readonly { content?: unknown }[] | undefined): string {
  const first = model?.[0]
  const blocks =
    first !== undefined && 'content' in first && Array.isArray(first.content) ? first.content : []
  return blocks
    .filter(
      (block): block is { type: 'text'; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text',
    )
    .map((block) => block.text)
    .join('\n')
}

function deriveStatus(submission: SubmissionRecord | undefined): 'pending' | 'done' | 'unanswered' {
  if (submission === undefined || submission.status === 'queued' || submission.status === 'placed')
    return 'pending'
  return submission.status
}

export class HandoffStore {
  readonly harness: Harness
  readonly sessionId: string
  private readonly context: Context
  private readonly seen = new Map<string, { id: SubmissionId; conversationId: ConversationId }>()
  private readonly scanPageSize: number

  private constructor(harness: Harness, context: Context, sessionId: string, scanPageSize: number) {
    this.harness = harness
    this.context = context
    this.sessionId = sessionId
    this.scanPageSize = scanPageSize
  }

  static async open(options: {
    models: MutableModels
    storePath: string
    context?: Context
    sessionId?: string
    scanPageSize?: number
  }): Promise<HandoffStore> {
    const context = options.context ?? BACKGROUND_CONTEXT
    const sessionId = options.sessionId ?? randomUUID()
    const scanPageSize =
      options.scanPageSize !== undefined && options.scanPageSize >= 1
        ? Math.floor(options.scanPageSize)
        : 100
    const storage = await openNodeSqliteStorage(options.storePath)
    const harness = await Harness.open(
      storage,
      {
        models: options.models,
        registry: createRegistry(),
        settings: buildHandoffSettings(sessionId),
      },
      context,
    )
    return new HandoffStore(harness, context, sessionId, scanPageSize)
  }

  async submit(
    request: HandoffSubmitRequest,
  ): Promise<{ id: SubmissionId; conversationId: ConversationId }> {
    const cached = this.seen.get(request.requestId)
    if (cached !== undefined) return cached
    const durable = await this.findByRequestId(request.requestId)
    if (durable !== undefined) {
      this.seen.set(request.requestId, durable)
      return durable
    }
    const conversation = await this.harness.createConversation(
      {
        ownership: { kind: 'ownerless' },
        agent: { model: request.model, instructions: request.instructions },
      },
      this.context,
    )
    const submission = await conversation.submit(
      { type: 'input', content: request.content, requestId: request.requestId },
      this.context,
    )
    // Always persisted: the requestId index for restart-proof dedup lives in this entry.
    await conversation.commit(
      (tx) =>
        tx.appendEntry(RequestEntry, conversation.id, {
          data: {
            sessionFile: request.meta?.sessionFile ?? '',
            goal: request.meta?.goal ?? '',
            createdAt: Date.now(),
            requestId: request.requestId,
          },
        }),
      this.context,
    )
    const result = { id: submission.id, conversationId: conversation.id }
    this.seen.set(request.requestId, result)
    return result
  }

  async wait(id: SubmissionId): Promise<HandoffResult> {
    const submission = await this.harness.submission(id, this.context)
    if (submission === undefined) throw new Error(`unknown submission: ${String(id)}`)
    const settled = await submission.wait(this.context)
    if (settled.status === 'unanswered') {
      const detail = formatDetail(settled.detail)
      return detail === undefined
        ? { status: 'unanswered', reason: settled.reason }
        : { status: 'unanswered', reason: settled.reason, detail }
    }
    const conversation = await this.harness.conversation(settled.conversationId, this.context)
    if (conversation === undefined)
      throw new Error(`unknown conversation for submission: ${String(id)}`)
    const entry = await conversation.commit(
      (tx) => tx.entry(AssistantEntry, settled.answer),
      this.context,
    )
    if (entry === undefined) throw new Error(`answer entry not found for submission: ${String(id)}`)
    return { status: 'done', text: renderAssistantText(entry.model) }
  }

  private async scanAllConversations(): Promise<ConversationRecord[]> {
    const records: ConversationRecord[] = []
    let cursor: Cursor | undefined = undefined
    for (;;) {
      const page = await this.harness.commit(
        (tx) => tx.scanConversations({}, this.scanPageSize, cursor),
        this.context,
      )
      records.push(...page.items)
      if (page.next === undefined) break
      cursor = page.next
    }
    return records
  }

  private async findByRequestId(
    requestId: string,
  ): Promise<{ id: SubmissionId; conversationId: ConversationId } | undefined> {
    for (const record of await this.scanAllConversations()) {
      if (record.id === ROOT_CONVERSATION_ID) continue
      const match = await this.harness.commit(async (tx) => {
        let cursor: Cursor | undefined = undefined
        for (;;) {
          const entries = await tx.scanEntries(
            { conversationId: record.id },
            this.scanPageSize,
            cursor,
          )
          const request = entries.items.find((entry) => RequestEntry.is(entry))
          if (request !== undefined && request.data.requestId === requestId) {
            const submission = await tx.submissionByRequest(record.id, requestId)
            return submission === undefined
              ? undefined
              : { id: submission.id, conversationId: record.id }
          }
          if (request !== undefined || entries.next === undefined) return undefined
          cursor = entries.next
        }
      }, this.context)
      if (match !== undefined) return match
    }
    return undefined
  }

  async list(): Promise<HandoffListItem[]> {
    const records = await this.scanAllConversations()
    const items: HandoffListItem[] = []
    for (const record of records) {
      if (record.id === ROOT_CONVERSATION_ID) continue
      const { meta, submission } = await this.readRequest(record.id)
      items.push({
        conversationId: record.id,
        status: deriveStatus(submission),
        sessionFile: meta?.sessionFile ?? '',
        goal: meta?.goal ?? '',
        ...(meta?.createdAt === undefined ? {} : { createdAt: meta.createdAt }),
      })
    }
    return items
  }

  async result(conversationId: ConversationId): Promise<HandoffConversationResult> {
    const { submission } = await this.readRequest(conversationId)
    if (
      submission === undefined ||
      submission.status === 'queued' ||
      submission.status === 'placed'
    )
      return { status: 'pending' }
    if (submission.status === 'unanswered') {
      const detail = formatDetail(submission.detail)
      return detail === undefined
        ? { status: 'unanswered', reason: submission.reason }
        : { status: 'unanswered', reason: submission.reason, detail }
    }
    if (submission.type !== 'input') return { status: 'pending' }
    const entry = await this.harness.commit(
      (tx) => tx.entry(AssistantEntry, submission.answer),
      this.context,
    )
    if (entry === undefined)
      throw new Error(`answer entry not found for conversation: ${String(conversationId)}`)
    return { status: 'done', text: renderAssistantText(entry.model) }
  }

  private async readRequest(conversationId: ConversationId): Promise<{
    meta: HandoffRequestData | undefined
    submission: SubmissionRecord | undefined
  }> {
    return this.harness.commit(async (tx) => {
      // Unknown ids read as pending; callers treat "no request entry" as not-found.
      const conversation = await tx.conversation(conversationId)
      if (conversation === undefined) return { meta: undefined, submission: undefined }
      const entries = await tx.scanEntries({ conversationId }, 100)
      const request = entries.items.find((entry) => RequestEntry.is(entry))
      const submission =
        request === undefined
          ? undefined
          : await tx.submissionByRequest(conversationId, request.data.requestId)
      return { meta: request?.data, submission }
    }, this.context)
  }

  async resume(): Promise<void> {
    this.harness.resume()
  }

  async waitForIdle(): Promise<void> {
    await this.harness.waitForIdle(this.context)
  }

  async close(): Promise<void> {
    await this.harness.close(this.context)
  }
}
