import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai'

type AuthFile = Record<string, Credential>

let tmpCounter = 0

export class JsonFileCredentialStore implements CredentialStore {
  private chain: Promise<void> = Promise.resolve()

  private authPath: string

  constructor(authPath: string) {
    this.authPath = authPath
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return (await this.readAll())[providerId]
  }

  async list(): Promise<CredentialInfo[]> {
    const data = await this.readAll()
    return Object.entries(data).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }))
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const run = this.chain.then(() => this.doModify(providerId, fn))
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  delete(providerId: string): Promise<void> {
    const run = this.chain.then(() => this.doDelete(providerId))
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async readAll(): Promise<AuthFile> {
    let raw: string
    try {
      raw = await readFile(this.authPath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw err
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`Malformed credential file: ${this.authPath}`)
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Malformed credential file: ${this.authPath}`)
    }
    return parsed as AuthFile
  }

  private async doModify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const data = await this.readAll()
    const next = await fn(data[providerId])
    if (next === undefined) return data[providerId]
    data[providerId] = next
    await this.writeAll(data)
    return next
  }

  private async doDelete(providerId: string): Promise<void> {
    const data = await this.readAll()
    if (!(providerId in data)) return
    delete data[providerId]
    await this.writeAll(data)
  }

  private async writeAll(data: AuthFile): Promise<void> {
    await mkdir(dirname(this.authPath), { recursive: true })
    const tmp = `${this.authPath}.${process.pid}.${tmpCounter++}.tmp`
    await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
    await rename(tmp, this.authPath)
  }
}
