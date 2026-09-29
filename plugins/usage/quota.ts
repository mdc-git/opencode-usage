import type { Plugin } from '@opencode/plugin'
import { z } from 'zod'
import type { QuotaSnapshot, UsageResponse } from './rpc.js'

export type QuotaAdapter = {
  readonly id: string
  readonly read: (context: Plugin.Context, signal: AbortSignal) => Promise<readonly QuotaSnapshot[]>
}

const OPENAI_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const REQUEST_TIMEOUT_MS = 10_000

const usageWindowSchema = z.preprocess(
  (value) => {
    if (typeof value !== 'object' || value === null) {
      return value
    }

    const raw = value as Record<string, unknown>
    return {
      usedPercent: raw.used_percent,
      resetAt: raw.reset_at
    }
  },
  z.looseObject({
    usedPercent: z.number(),
    resetAt: z.number().optional()
  })
)

const rateLimitSchema = z.preprocess(
  (value) => {
    if (typeof value !== 'object' || value === null) {
      return value
    }

    const raw = value as Record<string, unknown>
    return {
      primaryWindow: raw.primary_window,
      secondaryWindow: raw.secondary_window
    }
  },
  z.looseObject({
    primaryWindow: usageWindowSchema.nullable().optional(),
    secondaryWindow: usageWindowSchema.nullable().optional()
  })
)

const openAiUsageSchema = z.preprocess(
  (value) => {
    if (typeof value !== 'object' || value === null) {
      return value
    }

    const raw = value as Record<string, unknown>
    return { rateLimit: raw.rate_limit }
  },
  z.looseObject({
    rateLimit: rateLimitSchema.nullable().optional()
  })
)

const adapters: readonly QuotaAdapter[] = [
  {
    id: 'openai',
    read: readOpenAiQuota
  }
]

async function readOpenAiQuota(
  context: Plugin.Context,
  signal: AbortSignal
): Promise<readonly QuotaSnapshot[]> {
  let account = 'Account'

  try {
    const connection = await context.integration.connection.active('openai')
    if (!connection) {
      return [unavailable('OpenAI', 'No active OpenAI account', account)]
    }

    account = connection.type === 'credential' ? connection.label : 'Account'
    const credential = await context.integration.connection.resolve(connection)
    if (credential?.type !== 'oauth') {
      return [
        unavailable('OpenAI', 'The active OpenAI account is not a ChatGPT OAuth account', account)
      ]
    }

    const accountId = credential.metadata?.accountID
    const response = await fetch(OPENAI_USAGE_URL, {
      headers: {
        authorization: `Bearer ${credential.access}`,
        'user-agent': 'codex-cli',
        ...(typeof accountId === 'string' && {
          'chatgpt-account-id': accountId
        })
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    })

    if (!response.ok) {
      return [unavailable('OpenAI', `Usage endpoint returned HTTP ${response.status}`, account)]
    }

    const payload = openAiUsageSchema.parse(await response.json())
    const windows = [payload.rateLimit?.primaryWindow, payload.rateLimit?.secondaryWindow]
    const observedAt = new Date().toISOString()
    const snapshots = windows.flatMap((window) =>
      window ? [snapshotForWindow(window, observedAt, account)] : []
    )

    return snapshots.length > 0
      ? snapshots
      : [unavailable('OpenAI', 'No quota windows were returned', account)]
  } catch (error) {
    if (signal.aborted) {
      throw error
    }

    return [
      unavailable(
        'OpenAI',
        error instanceof Error ? error.message : 'Unable to read OpenAI usage',
        account
      )
    ]
  }
}

function snapshotForWindow(
  window: z.infer<typeof usageWindowSchema>,
  observedAt: string,
  account: string
): QuotaSnapshot {
  const used = Math.min(100, Math.max(0, window.usedPercent))

  return {
    provider: 'OpenAI',
    account,
    remaining: 100 - used,
    limit: 100,
    unit: 'percent',
    resetAt: resetAt(window.resetAt),
    observedAt,
    source: 'provider_api',
    status: 'available'
  }
}

function resetAt(timestamp: number | undefined) {
  return timestamp !== undefined && Number.isFinite(timestamp)
    ? new Date(timestamp * 1000).toISOString()
    : null
}

function unavailable(provider: string, message: string, account = 'Account'): QuotaSnapshot {
  return {
    provider,
    account,
    remaining: null,
    limit: null,
    unit: 'percent',
    resetAt: null,
    observedAt: new Date().toISOString(),
    source: 'provider_api',
    status: 'unavailable',
    message
  }
}

export async function readQuotas(
  context: Plugin.Context,
  signal: AbortSignal
): Promise<UsageResponse> {
  const results = await Promise.all(
    adapters.map(async (adapter) => {
      try {
        return await adapter.read(context, signal)
      } catch (error) {
        if (signal.aborted) {
          throw error
        }

        return [
          unavailable(
            adapter.id,
            error instanceof Error ? error.message : 'Unable to read provider usage'
          )
        ]
      }
    })
  )
  const snapshots = results.flat()

  return {
    fetchedAt: new Date().toISOString(),
    snapshots,
    status: snapshots.length > 0 ? 'ready' : 'empty'
  }
}
