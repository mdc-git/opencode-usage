/** @jsxImportSource @opentui/solid */

import { Plugin } from '@opencode/plugin/tui'
import { useTerminalDimensions } from '@opentui/solid'
import { Show as show, For as forEach } from 'solid-js'
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

  // Installed TUI sources use runtime JSX, so dynamic conditions need reactive getters.
  return show({
    get when() {
      return selectedProvider() === undefined || selectedProvider() === 'openai'
    },
    get children() {
      return (
        <box flexDirection="row" gap={1} flexShrink={0}>
          {show({
            get when() {
              return props.state.status === 'loading'
            },
            children: <text fg={props.context.theme.text.muted}>…</text>
          })}
          {show({
            get when() {
              return props.state.status === 'empty'
            },
            children: <text fg={props.context.theme.text.muted}>—</text>
          })}
          {show({
            get when() {
              return props.state.status === 'error'
            },
            children: <text fg={props.context.theme.text.feedback.error.base}>!</text>
          })}
          {show({
            get when() {
              return props.state.status === 'ready'
            },
            get children() {
              return show({
                get when() {
                  return dimensions().width >= 80
                },
                get fallback() {
                  return (
                    <text fg={props.context.theme.text.muted}>{groups().length} providers</text>
                  )
                },
                get children() {
                  return forEach({
                    get each() {
                      return groups()
                    },
                    children: (group: QuotaSnapshot[]) => (
                      <text fg={props.context.theme.text.muted}>{formatGroup(group)}</text>
                    )
                  })
                }
              })
            }
          })}
        </box>
      )
    }
  })
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

      try {
        const response = await usage.snapshot({}, { signal: controller.signal })
        const status = response.snapshots.length > 0 ? 'ready' : 'empty'
        if (
          state.status === status &&
          JSON.stringify(state.snapshots, (key, value: unknown) =>
            key === 'observedAt' ? undefined : value
          ) ===
            JSON.stringify(response.snapshots, (key, value: unknown) =>
              key === 'observedAt' ? undefined : value
            )
        ) {
          return
        }

        setState((draft) => {
          draft.status = status
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
      render: () =>
        show({
          get when() {
            return context.ui.router.current().type === 'home'
          },
          children: <Status context={context} state={state} />
        })
    })
    const stopPromptSlot = context.ui.slot({
      append: 'prompt.footer.status',
      render: () =>
        show({
          get when() {
            return context.ui.router.current().type !== 'home'
          },
          children: <Status context={context} state={state} />
        })
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
