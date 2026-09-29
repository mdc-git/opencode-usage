import { Plugin } from '@opencode/plugin'
import { readQuotas } from './quota.js'
import { usageRpc } from './rpc.js'

export default Plugin.define({
  id: 'mdc-git.usage',
  async setup(context) {
    const registration = await context.rpc.register(usageRpc, {
      async snapshot(_input, { signal }) {
        const snapshots = await readQuotas(context, signal)
        return {
          fetchedAt: new Date().toISOString(),
          snapshots,
          status: 'ready' as const
        }
      }
    })

    return async () => registration.dispose()
  }
})
