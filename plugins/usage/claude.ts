import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import type { Plugin } from '@opencode/plugin'
import { z } from 'zod'
import type { QuotaSelection, QuotaSnapshot } from './rpc.js'

const windowSchema = z.preprocess(
  (value) => {
    if (typeof value !== 'object' || value === null) {
      return value
    }

    const raw = value as Record<string, unknown>
    return { utilization: raw.utilization, resetAt: raw.resets_at }
  },
  z.object({ utilization: z.number(), resetAt: z.iso.datetime({ offset: true }).nullable() })
)
const usageSchema = z.preprocess(
  (value) => {
    if (typeof value !== 'object' || value === null) {
      return value
    }

    const raw = value as Record<string, unknown>
    return { fiveHour: raw.five_hour, sevenDay: raw.seven_day }
  },
  z.object({ fiveHour: windowSchema.nullish(), sevenDay: windowSchema.nullish() })
)
const authSchema = z.object({
  loggedIn: z.boolean(),
  authMethod: z.string(),
  apiProvider: z.string().optional(),
  configDirectory: z.string(),
  email: z.string().optional()
})
const credentialsSchema = z.object({ claudeAiOauth: z.object({ accessToken: z.string().min(1) }) })

let cache:
  { token: string; expiresAt: number; result: ReturnType<typeof fetchClaudeUsage> } | undefined

export async function readClaudeQuotas(
  context: Plugin.Context,
  signal: AbortSignal,
  selection: QuotaSelection = {}
): Promise<QuotaSnapshot[]> {
  let account = 'Account'

  try {
    const connection = await context.integration.connection.active('claude-agent')
    if (!connection) {
      return unavailable('No active Claude Agent account')
    }

    if (connection.type !== 'credential' || connection.method !== 'external') {
      return unavailable('Usage requires the active Claude Code external login')
    }

    const credential = await context.integration.connection.resolve(connection)
    if (credential?.type !== 'external' || credential.methodID !== 'claude-login') {
      return unavailable('Usage requires the active Claude Code external login')
    }

    const env = await claudeEnvironment(context, selection)
    if (
      ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].some(
        (name) => (env[name] ?? '') !== ''
      ) ||
      (env.ANTHROPIC_CUSTOM_HEADERS ?? '').split('\n').some((line) => {
        const name = line.split(':', 1)[0].trim().toLowerCase()
        return ['authorization', 'x-api-key'].includes(name)
      })
    ) {
      return unavailable('Usage requires a direct Claude subscription login')
    }

    const login = await claudeLogin(context.location.directory, env, signal)
    account = login.account
    if (login.token === undefined) {
      return unavailable('Usage requires a direct Claude subscription login', account)
    }

    const { token } = login
    signal.throwIfAborted()
    if (cache?.token !== token || cache.expiresAt <= Date.now()) {
      const entry = { token, expiresAt: Infinity, result: fetchClaudeUsage(token) }
      cache = entry
      void entry.result
        .then(({ expiresAt }) => {
          entry.expiresAt = expiresAt
        })
        .catch(() => {
          entry.expiresAt = 0
        })
    }

    const { snapshots } = await cache.result
    signal.throwIfAborted()
    return snapshots.map((snapshot) => ({ ...snapshot, account }))
  } catch (error) {
    if (signal.aborted) {
      throw error
    }

    return unavailable(
      'Unable to read Claude usage; check `claude auth status` and sign in with `claude auth login`',
      account
    )
  }
}

async function claudeLogin(directory: string, env: NodeJS.ProcessEnv, signal: AbortSignal) {
  const executable = env.OPENCODE_CLAUDE_PATH ?? ''
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      executable === '' ? 'claude' : executable,
      ['--setting-sources', '', 'auth', 'status'],
      {
        cwd: directory,
        env,
        signal,
        timeout: 10_000
      },
      (error, output) => {
        if (error instanceof Error) {
          reject(error)
        } else {
          resolve(output)
        }
      }
    )
  })
  const auth = authSchema.parse(JSON.parse(stdout))
  const account = auth.email ?? 'Account'
  if (
    !auth.loggedIn ||
    auth.apiProvider !== 'firstParty' ||
    !['claude.ai', 'oauth_token'].includes(auth.authMethod)
  ) {
    return { account, token: undefined }
  }

  let token = env.CLAUDE_CODE_OAUTH_TOKEN
  if (token === undefined || token === '') {
    const file = await readFile(path.join(auth.configDirectory, '.credentials.json'), 'utf8')
    token = credentialsSchema.parse(JSON.parse(file)).claudeAiOauth.accessToken
  }

  return { account, token }
}

async function claudeEnvironment(context: Plugin.Context, selection: QuotaSelection) {
  const providerKey = 'providerID'
  let settings: Readonly<Record<string, unknown>>
  let headers: Headers
  if (selection.modelId === undefined) {
    const { data: provider } = await context.provider.get({ [providerKey]: 'claude-agent' })
    settings = provider.settings ?? {}
    headers = new Headers(provider.headers)
  } else {
    const { data: models } = await context.model.list()
    const model = models.find(
      (model) => model.providerID === 'claude-agent' && model.id === selection.modelId
    )
    if (!model) {
      throw new Error('Selected Claude model is unavailable')
    }

    const variantId = selection.variant === 'default' ? undefined : selection.variant
    const variant = model.variants?.find((variant) => variant.id === variantId)
    if (variantId !== undefined && !variant) {
      throw new Error('Selected Claude variant is unavailable')
    }

    settings = { ...model.settings, ...variant?.settings }
    headers = new Headers(model.headers)
    for (const [name, value] of Object.entries(variant?.headers ?? {})) {
      headers.set(name, value)
    }
  }

  const env = { ...process.env }
  if ([...headers].length > 0) {
    env.ANTHROPIC_CUSTOM_HEADERS = [...headers]
      .map(([name, value]) => `${name}: ${value}`)
      .join('\n')
  }

  for (const [key, name] of [
    ['baseURL', 'ANTHROPIC_BASE_URL'],
    ['apiKey', 'ANTHROPIC_API_KEY'],
    ['authToken', 'ANTHROPIC_AUTH_TOKEN']
  ] as const) {
    if (typeof settings[key] === 'string') {
      env[name] = settings[key]
    }
  }

  env.CLAUDE_CODE_SIMPLE = undefined
  return env
}

async function fetchClaudeUsage(token: string) {
  const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      accept: 'application/json'
    },
    signal: AbortSignal.timeout(10_000)
  })
  let snapshots: QuotaSnapshot[]
  if (response.ok) {
    const payload = usageSchema.parse(await response.json())
    snapshots = [payload.fiveHour, payload.sevenDay].flatMap((window): QuotaSnapshot[] =>
      window
        ? [
            {
              provider: 'Claude Agent',
              remaining: 100 - Math.min(100, Math.max(0, window.utilization)),
              limit: 100,
              unit: 'percent',
              resetAt: window.resetAt,
              observedAt: new Date().toISOString(),
              source: 'provider_api',
              status: 'available'
            }
          ]
        : []
    )
    if (snapshots.length === 0) {
      snapshots = unavailable('No quota windows were returned')
    }
  } else {
    snapshots = unavailable(`Usage endpoint returned HTTP ${response.status}`)
  }

  const retryAfter = Number(response.headers.get('retry-after'))
  return {
    snapshots,
    expiresAt: Date.now() + Math.max(60_000, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0)
  }
}

function unavailable(message: string, account = 'Account'): QuotaSnapshot[] {
  return [
    {
      provider: 'Claude Agent',
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
  ]
}
