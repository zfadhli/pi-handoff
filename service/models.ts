import { homedir } from 'node:os'
import { join } from 'node:path'
import { createModels, type Models, type MutableModels } from '@earendil-works/pi-ai'
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek'
import { opencodeGoProvider } from '@earendil-works/pi-ai/providers/opencode-go'
import { JsonFileCredentialStore } from './auth-store.ts'

export const DEFAULT_PROVIDER = 'opencode-go'

const builtinProviderFactories = [deepseekProvider, opencodeGoProvider]

export function defaultAuthPath(): string {
  const override = process.env.PI_AUTH_FILE
  if (override) return override
  return join(homedir(), '.pi', 'agent', 'auth.json')
}

export function createServiceModels(authPath = defaultAuthPath()): MutableModels {
  const models = createModels({ credentials: new JsonFileCredentialStore(authPath) })
  for (const factory of builtinProviderFactories) models.setProvider(factory())
  return models
}

export function resolveModel(
  models: Models,
  providerId = DEFAULT_PROVIDER,
  modelId?: string,
): { provider: string; modelId: string } {
  if (!models.getProvider(providerId)) {
    const available = models.getProviders().map((p) => p.id)
    throw new Error(
      `Unknown provider '${providerId}': only built-in pi-ai providers are supported. Available providers: ${available.join(', ') || '(none)'}`,
    )
  }
  const availableModels = models.getModels(providerId)
  if (modelId !== undefined) {
    if (!models.getModel(providerId, modelId)) {
      throw new Error(
        `Unknown model '${modelId}' for provider '${providerId}'. Available models: ${availableModels.map((m) => m.id).join(', ') || '(none)'}`,
      )
    }
    return { provider: providerId, modelId }
  }
  const first = availableModels[0]
  if (!first) throw new Error(`No models available for provider '${providerId}'`)
  return { provider: providerId, modelId: first.id }
}
