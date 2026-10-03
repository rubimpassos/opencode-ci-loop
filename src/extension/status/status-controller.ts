import type { HostClient } from "@openchamber/sdk"
import type { PanelSnapshot, PanelWatch } from "../../panel-types.ts"
import type { PanelBinding, RequestFailure, SessionOutcome } from "../binding.ts"
import type { BindingState } from "../connection-view.ts"
import type { SessionControlState } from "../schemas.ts"

export type StatusModel = {
  readonly state: BindingState
  readonly sessionID: string | null
  readonly enabled: boolean | null
  readonly watch: PanelWatch | null
  readonly pending: boolean
  readonly failure: RequestFailure | null
  readonly canRetry: boolean
}

type Lookup =
  | { readonly kind: "idle" }
  | { readonly kind: "pending" }
  | { readonly kind: "ready"; readonly enabled: boolean }
  | { readonly kind: "error" }

type Confirmation = { readonly enabled: boolean; readonly snapshot: PanelSnapshot | null }

function assertNever(value: never): never {
  throw new Error(`unhandled status outcome ${JSON.stringify(value)}`)
}

export function createStatusController(
  binding: PanelBinding,
  host: Pick<HostClient, "onSession">,
  render: (model: StatusModel) => void,
): { readonly toggle: (enabled: boolean) => void; readonly retry: () => void; readonly dispose: () => void } {
  let state = binding.state()
  let sessionID: string | null = null
  let request = new AbortController()
  let generation = 0
  let lookup: Lookup = { kind: "idle" }
  let confirmation: Confirmation | null = null
  let pending = false
  let failure: RequestFailure | null = null
  let retryTarget: boolean | null = null
  let disposed = false

  const selected = () => state.snapshot?.sessions.find((session) => session.sessionID === sessionID)
  const writable = () =>
    !state.stale && (state.connection.kind === "live" || state.connection.kind === "polling")
  const enabled = (): boolean | null => {
    if (confirmation && (selected() === undefined || confirmation.snapshot === state.snapshot))
      return confirmation.enabled
    return selected()?.enabled ?? (lookup.kind === "ready" ? lookup.enabled : null)
  }
  const paint = (): void => {
    const current = selected()
    render({
      state,
      sessionID,
      enabled: sessionID === null ? null : enabled(),
      watch: current?.watches.at(-1) ?? null,
      pending,
      failure,
      canRetry: writable() && !pending,
    })
  }

  const complete = (id: string, ticket: number, outcome: SessionOutcome): SessionControlState | null => {
    if (disposed || ticket !== generation || id !== sessionID || request.signal.aborted) return null
    switch (outcome.kind) {
      case "ok":
        if (outcome.value.sessionID === id) return outcome.value
        failure = { kind: "invalid-data", reason: "unreadable" }
        return null
      case "failed":
        failure = outcome.failure
        return null
      case "superseded":
        return null
      default:
        return assertNever(outcome)
    }
  }

  const get = (): void => {
    if (sessionID === null || selected() !== undefined || lookup.kind !== "idle" || !writable()) return
    const id = sessionID
    const ticket = generation
    lookup = { kind: "pending" }
    paint()
    void binding.getSession(id, request.signal).then((outcome) => {
      if (disposed || ticket !== generation || id !== sessionID || outcome.kind === "superseded") return
      if (selected() !== undefined) return
      const result = complete(id, ticket, outcome)
      if (result) {
        lookup = { kind: "ready", enabled: result.enabled }
        failure = null
      } else {
        lookup = { kind: "error" }
      }
      paint()
    })
  }

  const toggle = (next: boolean): void => {
    if (sessionID === null || enabled() === null || !writable() || pending) return
    const id = sessionID
    const ticket = generation
    pending = true
    failure = null
    retryTarget = null
    paint()
    void binding.setEnabled(id, next, request.signal).then((outcome) => {
      if (disposed || ticket !== generation || id !== sessionID || outcome.kind === "superseded") return
      pending = false
      const result = complete(id, ticket, outcome)
      if (result) {
        confirmation = { enabled: result.enabled, snapshot: state.snapshot }
        lookup = { kind: "ready", enabled: result.enabled }
        failure = null
      } else {
        retryTarget = next
      }
      paint()
    })
  }

  const retry = (): void => {
    if (failure === null || !writable() || pending) return
    if (retryTarget !== null) {
      toggle(retryTarget)
      return
    }
    failure = null
    lookup = { kind: "idle" }
    get()
  }

  const unsubscribeState = binding.subscribe((next) => {
    const previous = state.snapshot
    const wasPresent = selected() !== undefined
    state = next
    if (previous !== next.snapshot) {
      if (selected() !== undefined) {
        confirmation = null
        lookup = { kind: "idle" }
        if (retryTarget === null) failure = null
      } else if (wasPresent) {
        lookup = { kind: "idle" }
      }
    }
    paint()
    get()
  })
  const unsubscribeSession = host.onSession((session) => {
    const next = session?.id ?? null
    if (next === sessionID) return
    request.abort()
    request = new AbortController()
    generation += 1
    sessionID = next
    lookup = { kind: "idle" }
    confirmation = null
    pending = false
    failure = null
    retryTarget = null
    paint()
    get()
  })

  return {
    toggle,
    retry,
    dispose: () => {
      if (disposed) return
      disposed = true
      request.abort()
      generation += 1
      unsubscribeState()
      unsubscribeSession()
    },
  }
}
