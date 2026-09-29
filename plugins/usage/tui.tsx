/** @jsxImportSource @opentui/solid */

import { Plugin } from '@opencode/plugin/tui'
import { useTerminalDimensions } from '@opentui/solid'
import { Show as show, For as forEach, createEffect, createSignal, on } from 'solid-js'
import { usageRpc, type QuotaSnapshot } from './rpc.js'

type State = {
  status: 'loading' | 'ready' | 'error'
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

  return `${value}%`
}

function formatResetAt(resetAt: QuotaSnapshot['resetAt']) {
  if (resetAt === null) {
    return '—'
  }

  const date = new Date(resetAt)
  if (Number.isNaN(date.getTime())) {
    return '—'
  }

  const minutes = Math.max(0, Math.floor((date.getTime() - Date.now()) / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const value = `${hours}:${String(minutes % 60).padStart(2, '0')}`

  return days === 0 ? `in ${value}` : `in ${days}d ${value}`
}

function formatGroup(snapshots: QuotaSnapshot[], isHovered: boolean) {
  const { provider, account } = snapshots[0]
  const windows = snapshots
    .map((snapshot) => (isHovered ? formatResetAt(snapshot.resetAt) : formatRemaining(snapshot)))
    .join(' · ')

  return isHovered
    ? windows
    : `${provider}${account === undefined ? '' : ` ${account}`} · ${windows}`
}

function currentLocation(context: Plugin.Context) {
  const route = context.ui.router.current()
  return route.type === 'session'
    ? (context.data.session.get(route.sessionID)?.location ??
        context.location ??
        context.data.location.default())
    : (context.location ?? context.data.location.default())
}

function Status(props: { context: Plugin.Context; state: State; refresh: () => Promise<void> }) {
  const dimensions = useTerminalDimensions()
  const [isHovered, setIsHovered] = createSignal(false)
  const groups = () =>
    Map.groupBy(
      props.state.snapshots,
      (snapshot) => `${snapshot.provider}\u{0}${snapshot.account ?? ''}`
    )
      .values()
      .toArray()

  createEffect(
    on(
      () => [
        props.context.ui.model.current()?.providerID,
        currentLocation(props.context).directory
      ],
      async () => {
        await props.refresh().catch(console.error)
      },
      { defer: true }
    )
  )

  // Installed TUI sources use runtime JSX, so dynamic conditions need reactive getters.
  return show({
    get when() {
      const provider = props.context.ui.model.current()?.providerID
      return provider === undefined || provider === 'openai'
    },
    get children() {
      return (
        <box
          flexDirection="row"
          gap={1}
          flexShrink={0}
          onMouseOver={() => {
            setIsHovered(true)
          }}
          onMouseOut={() => {
            setIsHovered(false)
          }}
        >
          {show({
            get when() {
              return props.state.status === 'loading'
            },
            get children() {
              return <text fg={props.context.theme.text.muted}>…</text>
            }
          })}
          {show({
            get when() {
              return props.state.status === 'error'
            },
            get children() {
              return <text fg={props.context.theme.text.feedback.error.base}>!</text>
            }
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
                    children: (group: QuotaSnapshot[]) =>
                      show({
                        get when() {
                          return isHovered()
                        },
                        get children() {
                          return (
                            <text fg={props.context.theme.text.muted}>
                              {formatGroup(group, true)}
                            </text>
                          )
                        },
                        get fallback() {
                          return (
                            <text fg={props.context.theme.text.muted}>
                              {formatGroup(group, false)}
                            </text>
                          )
                        }
                      })
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
    let isDisposed = false

    const refresh = async () => {
      if (controller.signal.aborted) {
        return
      }

      if (isRefreshing) {
        shouldRefreshAgain = true
        return
      }

      isRefreshing = true
      const { directory } = currentLocation(context)

      try {
        const response = await usage.snapshot(
          {},
          {
            signal: controller.signal,
            location: { directory }
          }
        )
        if (isDisposed) {
          return
        }

        if (directory !== currentLocation(context).directory) {
          shouldRefreshAgain = true
          return
        }

        if (
          state.status === 'ready' &&
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
          draft.status = 'ready'
          draft.snapshots = response.snapshots
        })
      } catch {
        if (isDisposed || controller.signal.aborted) {
          return
        }

        if (directory !== currentLocation(context).directory) {
          shouldRefreshAgain = true
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
          children: <Status context={context} state={state} refresh={refresh} />
        })
    })
    const stopPromptSlot = context.ui.slot({
      append: 'prompt.footer.status',
      render: () =>
        show({
          get when() {
            return context.ui.router.current().type !== 'home'
          },
          children: <Status context={context} state={state} refresh={refresh} />
        })
    })
    const stopCredentialListener = context.data.on('credential.switched', (event) => {
      if (event.data.integrationID !== 'openai') {
        return
      }

      refresh().catch(console.error)
    })
    const refreshOnTurn = (event: { data: { sessionID: string } }) => {
      const route = context.ui.router.current()
      if (route.type !== 'session' || route.sessionID !== event.data.sessionID) {
        return
      }

      refresh().catch(console.error)
    }

    const stopTurnStartListener = context.data.on('session.execution.started', refreshOnTurn)
    const stopTurnSucceededListener = context.data.on('session.execution.succeeded', refreshOnTurn)
    const stopTurnFailedListener = context.data.on('session.execution.failed', refreshOnTurn)
    const stopTurnInterruptedListener = context.data.on(
      'session.execution.interrupted',
      refreshOnTurn
    )

    refresh().catch(console.error)

    return () => {
      isDisposed = true
      controller.abort()
      stopCredentialListener()
      stopTurnStartListener()
      stopTurnSucceededListener()
      stopTurnFailedListener()
      stopTurnInterruptedListener()
      stopHomeSlot()
      stopPromptSlot()
    }
  }
})
