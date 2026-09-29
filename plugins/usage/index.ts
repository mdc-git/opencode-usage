import { Plugin } from '@opencode/plugin'
import { readQuotas } from './quota.js'
import { usageRpc } from './rpc.js'

export default Plugin.define({
  id: 'opencode.usage',
  async setup(context) {
    const registration = await context.rpc.register(usageRpc, {
      snapshot: async (_input, { signal }) => readQuotas(context, signal)
    })

    return async () => registration.dispose()
  }
})
