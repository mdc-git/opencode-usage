/** @jsxImportSource @opentui/solid */

import { Plugin } from '@opencode/plugin/tui'
import { useTerminalDimensions } from '@opentui/solid'
import { Show, For } from 'solid-js'
import { usageRpc, type QuotaSnapshot, type UsageResponse } from './rpc.js'

type State = {
  status: 'loading' | 'empty' | 'ready' | 'error'
  snapshots: UsageResponse['snapshots']
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

  if (days === 1) {
    return ` (morgen, ${value})`
  }

  if (days > 1) {
    return ` (in ${days} Tagen, ${value})`
  }

  return ` (${value})`
}

function formatGroup(snapshots: QuotaSnapshot[]) {
  const { provider, account } = snapshots[0]
  const windows = snapshots
    .map((snapshot) => `${formatRemaining(snapshot)}${formatResetAt(snapshot.resetAt)}`)
    .join(' · ')

  return `${provider}${account === undefined ? '' : ` ${account}`} · ${windows}`
}

function Status(props: { context: Plugin.Context; state: State }) {
  const dimensions = useTerminalDimensions()
  const selectedProvider = () => props.context.ui.model.current()?.providerID
  const groups = () =>
    Map.groupBy(
      props.state.snapshots,
      (snapshot) => `${snapshot.provider}\u{0}${snapshot.account ?? ''}`
    )
      .values()
      .toArray()

  return (
    <Show when={selectedProvider() === undefined || selectedProvider() === 'openai'}>
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
            when={dimensions().width >= 80}
            fallback={<text fg={props.context.theme.text.muted}>{groups().length} providers</text>}
          >
            <For each={groups()}>
              {(group) => <text fg={props.context.theme.text.muted}>{formatGroup(group)}</text>}
            </For>
          </Show>
        </Show>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: 'mdc-git.usage.tui',
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

    const stopHomeSlot = context.ui.slot({
      append: 'home.footer.status',
      render: () => (
        <Show when={context.ui.router.current().type === 'home'}>
          <Status context={context} state={state} />
        </Show>
      )
    })
    const stopPromptSlot = context.ui.slot({
      append: 'prompt.footer.status',
      render: () => (
        <Show when={context.ui.router.current().type !== 'home'}>
          <Status context={context} state={state} />
        </Show>
      )
    })
    const stopCredentialListener = context.data.on('credential.switched', (event) => {
      if (event.data.integrationID !== 'openai') {
        return
      }

      refresh().catch(console.error)
    })
    const stopModelListener = context.data.on('session.model.selected', (event) => {
      if (event.data.previous?.providerID === event.data.model.providerID) {
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
      stopModelListener()
      stopHomeSlot()
      stopPromptSlot()
    }
  }
})
