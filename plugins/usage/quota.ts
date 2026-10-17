import type { Credential, Plugin } from '@opencode/plugin'
import { z } from 'zod'
import type { QuotaSnapshot } from './rpc.js'

const OPENAI_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const REQUEST_TIMEOUT_MS = 10_000
const TOKEN_SHARING_METHOD_ID = 'chatgpt-token-sharing'
export const USAGE_LIMIT_CODE = 'subscription_sharing_usage_limit_exceeded'

/**
Observed plan-limit state of the active ChatGPT connection's model requests. OpenAI's token
sharing sign-in exposes limits only through request errors, so this latch is the only source.
*/
let isUsageLimitReached = false

export function reportUsageLimitReached() {
  isUsageLimitReached = true
}

export function reportUsageRequestAllowed() {
  isUsageLimitReached = false
}

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

export async function readQuotas(
  context: Plugin.Context,
  signal: AbortSignal
): Promise<QuotaSnapshot[]> {
  let account = 'Account'

  try {
    const connection = await context.integration.connection.active('openai')
    if (!connection) {
      return [unavailable('No active OpenAI account', account)]
    }

    account = connection.type === 'credential' ? connection.label : 'Account'
    const credential = await context.integration.connection.resolve(connection)
    if (credential?.type !== 'oauth') {
      return [unavailable('The active OpenAI account is not a ChatGPT OAuth account', account)]
    }

    if (typeof credential.metadata?.accountID === 'string') {
      return await readAccountUsage(credential, account, signal)
    }

    if (isUsageLimitReached && credential.methodID === TOKEN_SHARING_METHOD_ID) {
      return [unavailable('Usage limit reached', account)]
    }

    return [
      unavailable('OpenAI does not expose usage for the ChatGPT sign-in of this account', account)
    ]
  } catch (error) {
    if (signal.aborted) {
      throw error
    }

    return [
      unavailable(error instanceof Error ? error.message : 'Unable to read OpenAI usage', account)
    ]
  }
}

async function readAccountUsage(
  credential: Credential.OAuth,
  account: string,
  signal: AbortSignal
): Promise<QuotaSnapshot[]> {
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
    return [unavailable(`Usage endpoint returned HTTP ${response.status}`, account)]
  }

  const payload = openAiUsageSchema.parse(await response.json())
  const windows = [payload.rateLimit?.primaryWindow, payload.rateLimit?.secondaryWindow]
  const observedAt = new Date().toISOString()
  const snapshots = windows.flatMap((window) =>
    window ? [snapshotForWindow(window, observedAt, account)] : []
  )

  return snapshots.length > 0 ? snapshots : [unavailable('No quota windows were returned', account)]
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
    resetAt: window.resetAt === undefined ? null : new Date(window.resetAt * 1000).toISOString(),
    observedAt,
    source: 'provider_api',
    status: 'available'
  }
}

function unavailable(message: string, account: string): QuotaSnapshot {
  return {
    provider: 'OpenAI',
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
