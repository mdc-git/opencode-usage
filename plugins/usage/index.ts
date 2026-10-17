import type { Plugin } from '@opencode/plugin'
import {
  readQuotas,
  reportUsageLimitReached,
  reportUsageRequestAllowed,
  USAGE_LIMIT_CODE
} from './quota.js'
import { usageRpc } from './rpc.js'

const OPENAI_PROVIDER_ID = 'openai'

const usagePlugin = {
  id: 'mdc-git.usage',
  async setup(context: Plugin.Context) {
    const registrations = [
      await context.session.hook('retry', (event) => {
        if (event.model.providerID !== OPENAI_PROVIDER_ID) {
          return
        }

        if (event.error.response?.body?.includes(USAGE_LIMIT_CODE)) {
          reportUsageLimitReached()
        }
      }),
      await context.session.hook('http.response', (event) => {
        if (event.model.providerID !== OPENAI_PROVIDER_ID) {
          return
        }

        if (event.response.status === 200) {
          reportUsageRequestAllowed()
        }
      })
    ]
    await context.rpc.register(usageRpc, {
      async snapshot(_input, { signal }) {
        const snapshots = await readQuotas(context, signal)
        return {
          fetchedAt: new Date().toISOString(),
          snapshots,
          status: 'ready' as const
        }
      }
    })
    return async () =>
      Promise.all(registrations.map(async (registration) => registration.dispose()))
  }
}

export default usagePlugin
