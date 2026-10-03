import { describe, expect, it } from "bun:test"
import type { PanelSession, PanelSnapshot, PanelWatch } from "../panel-types.ts"
import { badgeCount, bindBadge, failedWatchCount } from "./badge.ts"
import type { BindingState, Connection } from "./connection-view.ts"
import { snapshot as baseSnapshot, flush } from "./fake-host.test-support.ts"

const base = baseSnapshot("en", "fix ci")
const [baseSession] = base.sessions
const [baseWatch] = baseSession?.watches ?? []
if (!baseSession || !baseWatch) throw new Error("fixture snapshot needs one session with one watch")

const watch = (key: string, overrides: Partial<PanelWatch>): PanelWatch => ({
  ...baseWatch,
  key,
  ...overrides,
})
const session = (sessionID: string, watches: readonly PanelWatch[], enabled = true): PanelSession => ({
  ...baseSession,
  sessionID,
  enabled,
  watches,
})
const withSessions = (sessions: readonly PanelSession[]): PanelSnapshot => ({ ...base, sessions })
const live = (snapshot: PanelSnapshot | null, stale = false, connection: Connection = { kind: "live" }) =>
  ({ connection, snapshot, stale, locale: "en" }) satisfies BindingState

const prBlocked = watch("o/r\0pr", {
  phaseKey: "done-green",
  tone: "warn",
  failed: false,
  failures: [],
  pr: {
    number: 1,
    title: "t",
    url: "https://github.com/o/r/pull/1",
    ready: false,
    verdictLabel: "not ready",
    blockers: ["review required", "draft"],
    draftLabel: "draft",
  },
})

describe("failedWatchCount", () => {
  it("counts failed watches once each, not sessions, runs or failed jobs", () => {
    const manyJobs = watch("a", {
      runs: [...baseWatch.runs, ...baseWatch.runs, ...baseWatch.runs],
      failures: [
        { runName: "a", logTail: "x" },
        { runName: "b", logTail: "y" },
      ],
    })
    const snapshot = withSessions([
      session("s1", [manyJobs, watch("b", {}), watch("c", { failed: false, phaseKey: "done-green" })]),
      session("s2", [watch("d", {})]),
    ])

    expect(failedWatchCount(snapshot)).toBe(3)
  })

  it("counts a reviewing watch that carries a failed report", () => {
    const snapshot = withSessions([session("s1", [watch("a", { phaseKey: "reviewing", failed: true })])])

    expect(failedWatchCount(snapshot)).toBe(1)
  })

  it("does not count PR-only blockers", () => {
    expect(failedWatchCount(withSessions([session("s1", [prBlocked])]))).toBe(0)
  })

  it("counts stored failures of paused sessions", () => {
    expect(failedWatchCount(withSessions([session("s1", [watch("a", {})], false)]))).toBe(1)
  })
})

describe("badgeCount", () => {
  it("clears instead of showing zero", () => {
    expect(badgeCount(live(withSessions([session("s1", [prBlocked])])))).toBeNull()
  })

  it("shows the count for fresh polled data", () => {
    expect(badgeCount(live(base, false, { kind: "polling" }))).toBe(1)
  })

  it("clears on a stale snapshot", () => {
    expect(badgeCount(live(base, true))).toBeNull()
  })

  it.each<Connection>([
    { kind: "connecting" },
    { kind: "unavailable", code: null, status: 502 },
    { kind: "forbidden" },
    { kind: "invalid-data", reason: "update-required" },
  ])("clears when the connection is %o", (connection) => {
    expect(badgeCount(live(base, false, connection))).toBeNull()
  })
})

function fakeBinding(): {
  readonly subscribe: (listener: (state: BindingState) => void) => () => void
  readonly push: (state: BindingState) => void
  readonly listeners: () => number
} {
  const listeners = new Set<(state: BindingState) => void>()
  let current: BindingState = live(null, false, { kind: "connecting" })
  return {
    subscribe: (listener) => {
      listeners.add(listener)
      listener(current)
      return () => listeners.delete(listener)
    },
    push: (state) => {
      current = state
      for (const listener of listeners) listener(state)
    },
    listeners: () => listeners.size,
  }
}

describe("bindBadge", () => {
  it("writes only changes and clears on disconnect", () => {
    const binding = fakeBinding()
    const writes: (number | null)[] = []
    bindBadge(binding, async (count) => void writes.push(count))

    binding.push(live(base))
    binding.push(live(base))
    binding.push(live(base, true, { kind: "unavailable", code: null, status: null }))

    expect(writes).toEqual([null, 1, null])
  })

  it("clears the badge and unsubscribes when stopped", () => {
    const binding = fakeBinding()
    const writes: (number | null)[] = []
    const stop = bindBadge(binding, async (count) => void writes.push(count))
    binding.push(live(base))

    stop()

    expect({ writes, listeners: binding.listeners() }).toEqual({ writes: [null, 1, null], listeners: 0 })
  })

  it("retries a write the host rejected", async () => {
    const binding = fakeBinding()
    const writes: (number | null)[] = []
    let reject = false
    bindBadge(binding, (count) => {
      writes.push(count)
      return reject ? Promise.reject(new Error("HOST_TIMEOUT")) : Promise.resolve()
    })
    reject = true
    binding.push(live(base))
    await flush()
    reject = false

    binding.push(live(base))

    expect(writes).toEqual([null, 1, 1])
  })
})
