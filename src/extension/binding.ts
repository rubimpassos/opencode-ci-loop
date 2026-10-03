import type { LoopbackWatchEvent } from "@openchamber/sdk"
import type { BindingState, Connection } from "./connection-view.ts"
import type { GuestLocale } from "./locale.ts"
import {
  type BindingHost,
  failureFromError,
  loopbackCall,
  type RequestFailure,
  type RequestOutcome,
} from "./request.ts"
import { parsePanelSnapshot, parseSessionControl, type SessionControlState } from "./schemas.ts"

export type { BindingHost, RequestFailure, RequestOutcome } from "./request.ts"

/** Timer seam: returns a cancel function. */
export type Schedule = (callback: () => void, delayMs: number) => () => void

export type PanelBindingOptions = {
  readonly host: BindingHost
  readonly locale: GuestLocale
  readonly schedule?: Schedule
}

/** `superseded`: a newer call for the same session/operation, the caller's abort, or dispose won. */
export type SessionOutcome = RequestOutcome<SessionControlState> | { readonly kind: "superseded" }

export type PanelBinding = {
  readonly state: () => BindingState
  /** Replays the current state immediately; returns the unsubscribe function. */
  readonly subscribe: (listener: (state: BindingState) => void) => () => void
  readonly setLocale: (locale: GuestLocale) => void
  readonly getSession: (sessionID: string, signal?: AbortSignal) => Promise<SessionOutcome>
  readonly setEnabled: (sessionID: string, enabled: boolean, signal?: AbortSignal) => Promise<SessionOutcome>
  readonly dispose: () => void
}

export const POLL_INTERVAL_MS = 5_000

const defaultSchedule: Schedule = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs)
  return () => clearTimeout(timer)
}

function connectionFromFailure(failure: RequestFailure): Connection {
  switch (failure.kind) {
    case "forbidden":
      return { kind: "forbidden" }
    case "unavailable":
      return { kind: "unavailable", code: failure.code, status: failure.status }
    case "rejected":
      return { kind: "unavailable", code: null, status: failure.status }
    case "invalid-data":
      return { kind: "invalid-data", reason: failure.reason }
    default:
      return assertNever(failure)
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled variant ${JSON.stringify(value)}`)
}

const sessionPath = (sessionID: string): string => `/sessions/${encodeURIComponent(sessionID)}`

export function createPanelBinding(options: PanelBindingOptions): PanelBinding {
  const { host } = options
  const schedule = options.schedule ?? defaultSchedule
  const listeners = new Set<(state: BindingState) => void>()
  const generations = new Map<string, number>()
  let state: BindingState = {
    connection: { kind: "connecting" },
    snapshot: null,
    stale: false,
    locale: options.locale,
  }
  let mode: "stream" | "poll" = "stream"
  let epoch = 0
  let sequence = 0
  let stopFeed: () => void = () => {}
  let disposed = false

  const emit = (next: BindingState): void => {
    state = next
    for (const listener of listeners) listener(state)
  }
  const fail = (connection: Connection): void =>
    emit({ ...state, connection, stale: state.snapshot !== null })
  const accept = (text: string): void => {
    const parsed = parsePanelSnapshot(text)
    if (parsed.ok) emit({ ...state, connection: { kind: "live" }, snapshot: parsed.value, stale: false })
    else fail({ kind: "invalid-data", reason: parsed.reason })
  }

  const startPolling = (feed: number): void => {
    mode = "poll"
    let cancelTimer: () => void = () => {}
    const tick = (): void => {
      const call = { path: "/panel/state", method: "GET", query: { locale: state.locale } } as const
      void loopbackCall(host, call, parsePanelSnapshot).then((outcome) => {
        if (feed !== epoch) return
        if (outcome.kind === "ok")
          emit({ ...state, connection: { kind: "polling" }, snapshot: outcome.value, stale: false })
        else fail(connectionFromFailure(outcome.failure))
        cancelTimer = schedule(tick, POLL_INTERVAL_MS)
      })
    }
    stopFeed = () => cancelTimer()
    tick()
  }

  const onConnection = (feed: number, event: Extract<LoopbackWatchEvent, { type: "connection" }>): void => {
    switch (event.state) {
      case "connecting":
        fail({ kind: "connecting" })
        break
      case "live":
        emit({ ...state, connection: { kind: "live" } })
        break
      case "unavailable":
        if (event.error?.code === "UNSUPPORTED") {
          stopFeed()
          startPolling(feed)
        } else {
          fail(connectionFromFailure(failureFromError(event.error)))
        }
        break
      default:
        assertNever(event.state)
    }
  }

  const onWatch = (feed: number, event: LoopbackWatchEvent): void => {
    if (feed !== epoch) return
    switch (event.type) {
      case "data":
        accept(event.text)
        break
      case "connection":
        onConnection(feed, event)
        break
      default:
        assertNever(event)
    }
  }

  const start = (): void => {
    const feed = ++epoch
    if (mode === "poll") {
      startPolling(feed)
      return
    }
    try {
      stopFeed = host.watchLoopback({ path: "/panel/events", query: { locale: state.locale } }, (event) =>
        onWatch(feed, event),
      )
    } catch (error) {
      stopFeed = () => {}
      fail(connectionFromFailure(failureFromError(error)))
    }
  }

  const sessionCall = async (
    key: string,
    call: Parameters<BindingHost["loopbackRequest"]>[0],
    signal: AbortSignal | undefined,
  ): Promise<SessionOutcome> => {
    const generation = ++sequence
    generations.set(key, generation)
    const isCurrent = (): boolean =>
      !disposed && generations.get(key) === generation && signal?.aborted !== true
    if (!isCurrent()) return { kind: "superseded" }
    const outcome = await loopbackCall(host, call, parseSessionControl)
    if (!isCurrent()) return { kind: "superseded" }
    generations.delete(key)
    return outcome
  }

  start()
  return {
    state: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      listener(state)
      return () => listeners.delete(listener)
    },
    setLocale: (locale) => {
      if (disposed || locale === state.locale) return
      stopFeed()
      emit({ ...state, locale, connection: { kind: "connecting" }, stale: state.snapshot !== null })
      start()
    },
    getSession: (sessionID, signal) =>
      sessionCall(`get:${sessionID}`, { path: sessionPath(sessionID), method: "GET" }, signal),
    setEnabled: (sessionID, enabled, signal) => {
      const writable = state.connection.kind === "live" || state.connection.kind === "polling"
      if (!writable || disposed) {
        return Promise.resolve({ kind: "failed", failure: connectionFailure(state.connection) })
      }
      const call = { path: `${sessionPath(sessionID)}/enabled`, method: "POST", body: { enabled } } as const
      return sessionCall(`set:${sessionID}`, call, signal)
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      epoch += 1
      stopFeed()
      listeners.clear()
    },
  }
}

/** A write is refused locally when the connection could not confirm it; mirror why. */
function connectionFailure(connection: Connection): RequestFailure {
  switch (connection.kind) {
    case "forbidden":
      return { kind: "forbidden" }
    case "invalid-data":
      return { kind: "invalid-data", reason: connection.reason }
    case "unavailable":
      return { kind: "unavailable", code: connection.code, status: connection.status }
    case "connecting":
    case "live":
    case "polling":
      return { kind: "unavailable", code: null, status: null }
    default:
      return assertNever(connection)
  }
}
