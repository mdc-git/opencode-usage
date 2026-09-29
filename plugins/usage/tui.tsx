/** @jsxImportSource @opentui/solid */

import { Plugin } from '@opencode/plugin/tui'
import { useTerminalDimensions } from '@opentui/solid'
import { Show, For } from 'solid-js'
import { usageRpc, type QuotaSnapshot, type UsageResponse } from './rpc.js'

type State = {
  status: 'loading' | 'empty' | 'ready' | 'error'
  snapshots: UsageResponse['snapshots']
}

type SnapshotGroup = {
  provider: string
  account?: string
  snapshots: QuotaSnapshot[]
}

function formatRemaining(snapshot: QuotaSnapshot) {
  if (snapshot.status !== 'available' || snapshot.remaining === null) {
    return '—'
  }

  const value = new Intl.NumberFormat('de-DE', {
    maximumFractionDigits: 1,
    notation: 'compact'
  }).format(snapshot.remaining)

  if (snapshot.unit === 'dollars') {
    return `$${value}`
  }

  if (snapshot.unit === 'tokens') {
    return `${value} tok`
  }

  if (snapshot.unit === 'requests') {
    return `${value} req`
  }

  if (snapshot.unit === 'percent') {
    return `${value}%`
  }

  return value
}

function formatResetAt(resetAt: QuotaSnapshot['resetAt']) {
  if (resetAt === null) {
    return ''
  }

  const date = new Date(resetAt)
  if (Number.isNaN(date.getTime())) {
    return ''
  }

  const value = new Intl.DateTimeFormat('de-DE', {
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)

  const now = new Date()
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  const resetDay = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  const days = Math.round((resetDay - today) / 86_400_000)

  if (days === 0) {
    return ` (${value})`
  }

  if (days === 1) {
    return ` (morgen, ${value})`
  }

  if (days > 1) {
    return ` (in ${days} Tagen, ${value})`
  }

  return ` (${value})`
}

function groupSnapshots(snapshots: readonly QuotaSnapshot[]) {
  const groups = new Map<string, SnapshotGroup>()

  for (const snapshot of snapshots) {
    const key = `${snapshot.provider}\u{0}${snapshot.account ?? ''}`
    const group = groups.get(key)
    if (group) {
      group.snapshots.push(snapshot)
      continue
    }

    groups.set(key, {
      provider: snapshot.provider,
      account: snapshot.account,
      snapshots: [snapshot]
    })
  }

  return groups.values().toArray()
}

function formatGroup(group: SnapshotGroup) {
  const account = group.account === undefined ? '' : ` ${group.account}`
  const windows = group.snapshots
    .map((snapshot) => `${formatRemaining(snapshot)}${formatResetAt(snapshot.resetAt)}`)
    .join(' · ')

  return `${group.provider}${account} ${windows}`
}

function Status(props: { context: Plugin.Context; state: State }) {
  const dimensions = useTerminalDimensions()
  const isCompact = () => dimensions().width < 80
  const groups = () => groupSnapshots(props.state.snapshots)

  return (
    <box flexDirection="row" gap={1} flexShrink={0}>
      <Show when={props.state.status === 'loading'}>
        <text fg={props.context.theme.text.muted}>…</text>
      </Show>
      <Show when={props.state.status === 'empty'}>
        <text fg={props.context.theme.text.muted}>—</text>
      </Show>
      <Show when={props.state.status === 'error'}>
        <text fg={props.context.theme.text.feedback.error.base}>!</text>
      </Show>
      <Show when={props.state.status === 'ready'}>
        <Show
          when={!isCompact()}
          fallback={<text fg={props.context.theme.text.muted}>{groups().length} providers</text>}
        >
          <For each={groups()}>
            {(group) => <text fg={props.context.theme.text.muted}>{formatGroup(group)}</text>}
          </For>
        </Show>
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: 'opencode.usage.tui',
  setup(context) {
    const usage = context.client.rpc(usageRpc)
    const [state, setState] = context.storage.memory<State>('quota', {
      initial: {
        status: 'loading',
        snapshots: []
      }
    })
    const controller = new AbortController()
    let isRefreshing = false
    let shouldRefreshAgain = false

    const refresh = async () => {
      if (controller.signal.aborted) {
        return
      }

      if (isRefreshing) {
        shouldRefreshAgain = true
        return
      }

      isRefreshing = true
      setState((draft) => {
        draft.status = 'loading'
      })

      try {
        const response = await usage.snapshot({}, { signal: controller.signal })
        setState((draft) => {
          draft.status = response.snapshots.length > 0 ? 'ready' : 'empty'
          draft.snapshots = response.snapshots
        })
      } catch {
        if (controller.signal.aborted) {
          return
        }

        setState((draft) => {
          draft.status = 'error'
        })
      } finally {
        isRefreshing = false
        if (shouldRefreshAgain && !controller.signal.aborted) {
          shouldRefreshAgain = false
          await refresh()
        }
      }
    }

    const stopSlot = context.ui.slot({
      append: 'prompt.footer.status',
      render: () => <Status context={context} state={state} />
    })
    const stopCredentialListener = context.data.on('credential.switched', (event) => {
      if (event.data.integrationID !== 'openai') {
        return
      }

      refresh().catch(console.error)
    })
    const timer = setInterval(() => {
      refresh().catch(console.error)
    }, 60_000)

    refresh().catch(console.error)

    return () => {
      controller.abort()
      clearInterval(timer)
      stopCredentialListener()
      stopSlot()
    }
  }
})
