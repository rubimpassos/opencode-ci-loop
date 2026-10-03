import type { LoopbackWatchEvent } from "@openchamber/sdk"
import { CATALOGS, type Locale } from "../i18n.ts"
import { buildChrome } from "../panel-locale.ts"
import type { PanelSnapshot, PanelWatch } from "../panel-types.ts"
import type { Schedule } from "./binding.ts"
import type { BindingHost } from "./request.ts"

type LoopbackCall = Parameters<BindingHost["loopbackRequest"]>[0]
type LoopbackResult = Awaited<ReturnType<BindingHost["loopbackRequest"]>>

export type FakeWatch = {
  readonly request: Parameters<BindingHost["watchLoopback"]>[0]
  readonly emit: (event: LoopbackWatchEvent) => void
  disposed: boolean
}

export type FakeRequest = {
  readonly call: LoopbackCall
  readonly respond: (result: LoopbackResult) => void
  readonly reject: (error: Error) => void
}

/** Records watches and finite requests; each request stays pending until the test settles it. */
export function fakeHost(): BindingHost & {
  readonly watches: FakeWatch[]
  readonly requests: FakeRequest[]
} {
  const watches: FakeWatch[] = []
  const requests: FakeRequest[] = []
  return {
    watches,
    requests,
    watchLoopback: (request, listener) => {
      const watch: FakeWatch = { request, emit: (event) => listener(event), disposed: false }
      watches.push(watch)
      return () => {
        watch.disposed = true
      }
    },
    loopbackRequest: (call) =>
      new Promise<LoopbackResult>((respond, reject) => {
        requests.push({ call, respond, reject })
      }),
  }
}

export type FakeClock = {
  readonly schedule: Schedule
  readonly pending: () => number
  readonly fire: () => void
}

export function fakeClock(): FakeClock {
  const timers = new Set<() => void>()
  return {
    schedule: (callback) => {
      timers.add(callback)
      return () => timers.delete(callback)
    },
    pending: () => timers.size,
    fire: () => {
      const due = [...timers]
      timers.clear()
      for (const callback of due) callback()
    },
  }
}

/** Lets pending promise callbacks (request settlement → binding update) run. */
export const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

export function snapshot(locale: Locale, title: string): PanelSnapshot {
  const watch: PanelWatch = {
    key: "o/r\0main",
    meta: "o/r · main",
    phaseKey: "done-failed",
    tone: "fail",
    phaseLabel: "failed",
    failed: true,
    runs: [
      { name: "ci", url: "https://github.com/o/r/actions/runs/1", status: "completed", state: "failure" },
    ],
    checks: [],
    failures: [{ runName: "ci", logTail: "boom" }],
    pr: null,
    searchText: "o/r main",
  }
  return {
    chrome: buildChrome(CATALOGS[locale]),
    sessions: [
      {
        sessionID: "ses_1",
        title,
        projectLabel: "r",
        directory: "/w/r",
        enabled: true,
        watches: [watch],
        searchText: title,
      },
    ],
  }
}
