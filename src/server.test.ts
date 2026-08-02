import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { z } from "zod"
import { DASHBOARD_HTML } from "./dashboard.ts"
import { DASHBOARD_SCRIPT } from "./dashboard-script.ts"
import { DASHBOARD_STYLES } from "./dashboard-styles.ts"
import { PANEL_PHASE_KEYS, type PanelChrome, type PanelSession, type PanelSnapshot } from "./panel-types.ts"
import {
  type BindTuning,
  DashboardServer,
  isAllowedHost,
  type PanelMapper,
  type SessionControl,
} from "./server.ts"
import type { CommitSha, LogLevel, LogSink, SessionId, SessionState, Watch } from "./types.ts"

const noopLog: LogSink = () => {}

describe("isAllowedHost", () => {
  it.each([
    ["127.0.0.1:4517", true],
    ["localhost:4517", true],
    ["LOCALHOST:4517", true],
    ["[::1]:4517", true],
    ["evil.example.com:4517", false],
    ["127.0.0.1:9999", false],
    ["127.0.0.1", false],
    [null, false],
  ])("host %j allowed=%p on port 4517", (hostHeader, expected) => {
    expect(isAllowedHost(hostHeader, 4517)).toBe(expected)
  })
})

describe("DASHBOARD_HTML", () => {
  it("embeds the styles and the script", () => {
    expect(DASHBOARD_HTML).toContain(DASHBOARD_STYLES)
    expect(DASHBOARD_HTML).toContain(DASHBOARD_SCRIPT)
  })
})

const TEST_PORT = 45917
const StateResponseSchema = z.array(
  z.object({
    watches: z.array(z.object({ branch: z.string() })),
    watch: z.object({ branch: z.string() }).nullable(),
  }),
)

function sessionState(id: string, enabled: boolean): SessionState {
  return { sessionID: id as SessionId, enabled, watches: [], watch: null, directory: null }
}

function waitingWatch(branch: string): Watch {
  return {
    sha: "abcdef1234567890" as CommitSha,
    branch,
    repo: "github.com/o/r",
    repoUrl: "https://github.com/o/r",
    directory: `/repo-${branch}`,
    sourceKind: "linked-worktree",
    startedAt: 1,
    phase: { kind: "waiting" },
  }
}

function fakeControl(): { control: SessionControl; calls: Array<[string, boolean]> } {
  const store = new Map<string, boolean>()
  const calls: Array<[string, boolean]> = []
  return {
    calls,
    control: {
      getSession: (id) => sessionState(id, store.get(id) ?? true),
      setEnabled: (id, enabled) => {
        calls.push([id, enabled])
        store.set(id, enabled)
        return sessionState(id, enabled)
      },
    },
  }
}

describe("DashboardServer control routes", () => {
  let server: DashboardServer | null = null

  afterEach(() => {
    server?.stop()
    server = null
  })

  function startServer(control?: SessionControl): string {
    server = new DashboardServer({ enabled: true, host: "127.0.0.1", port: TEST_PORT }, noopLog)
    if (control) server.setControl(control)
    server.start()
    return `http://127.0.0.1:${TEST_PORT}`
  }

  it("GET /sessions/:id returns the session view", async () => {
    const { control } = fakeControl()
    const base = startServer(control)

    const response = await fetch(`${base}/sessions/ses_abc`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      sessionID: "ses_abc",
      enabled: true,
      watches: [],
      watch: null,
      directory: null,
    })
  })

  it("POST /sessions/:id/enabled toggles and returns the new state", async () => {
    const { control, calls } = fakeControl()
    const base = startServer(control)

    const response = await fetch(`${base}/sessions/ses_abc/enabled`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      sessionID: "ses_abc",
      enabled: false,
      watches: [],
      watch: null,
      directory: null,
    })
    expect(calls).toEqual([["ses_abc", false]])
  })

  it("POST /sessions/:id/enabled rejects invalid bodies", async () => {
    const { control, calls } = fakeControl()
    const base = startServer(control)

    const missing = await fetch(`${base}/sessions/ses_abc/enabled`, { method: "POST", body: "not json" })
    const wrongType = await fetch(`${base}/sessions/ses_abc/enabled`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    })

    expect(missing.status).toBe(400)
    expect(wrongType.status).toBe(400)
    expect(calls).toEqual([])
  })

  it("rejects wrong methods on control routes", async () => {
    const { control } = fakeControl()
    const base = startServer(control)

    const postSession = await fetch(`${base}/sessions/ses_abc`, { method: "POST" })
    const getEnabled = await fetch(`${base}/sessions/ses_abc/enabled`)

    expect(postSession.status).toBe(405)
    expect(getEnabled.status).toBe(405)
  })

  it("returns 404 when no control is wired", async () => {
    const base = startServer()

    const response = await fetch(`${base}/sessions/ses_abc`)

    expect(response.status).toBe(404)
  })

  it("GET /state responds with the dashboard marker header", async () => {
    const base = startServer()

    const response = await fetch(`${base}/state`)

    expect(response.status).toBe(200)
    expect(response.headers.get("x-ci-loop")).toBe("dashboard")
  })

  it("HEAD /state answers the marker without serializing the snapshot", async () => {
    const base = startServer()
    server?.broadcast([
      {
        sessionID: "ses_probe" as SessionId,
        enabled: true,
        watches: [waitingWatch("f")],
        watch: null,
        directory: null,
      },
    ])

    const response = await fetch(`${base}/state`, { method: "HEAD" })

    expect(response.status).toBe(200)
    expect(response.headers.get("x-ci-loop")).toBe("dashboard")
    expect(response.headers.get("content-length")).toBe("0")
    expect(await response.text()).toBe("")
  })

  it("GET /state carries every watch plus the deprecated latest-watch alias", async () => {
    const base = startServer()
    const first = waitingWatch("feature-a")
    const second = { ...waitingWatch("feature-b"), startedAt: 2 }
    server?.broadcast([
      {
        sessionID: "ses_multi" as SessionId,
        enabled: true,
        watches: [first, second],
        watch: second,
        directory: "/repo",
      },
    ])

    const response = await fetch(`${base}/state`)
    const state = StateResponseSchema.parse(await response.json())

    expect(state[0]?.watches.map((watch) => watch.branch)).toEqual(["feature-a", "feature-b"])
    expect(state[0]?.watch?.branch).toBe("feature-b")
  })

  it("SSE snapshots carry the watches collection", async () => {
    const base = startServer()
    const watch = waitingWatch("feature")
    server?.broadcast([
      {
        sessionID: "ses_sse" as SessionId,
        enabled: true,
        watches: [watch],
        watch,
        directory: "/repo",
      },
    ])

    const response = await fetch(`${base}/events`)
    const reader = response.body?.getReader()
    const chunk = await reader?.read()
    await reader?.cancel()

    expect(new TextDecoder().decode(chunk?.value)).toContain('"watches"')
    expect(new TextDecoder().decode(chunk?.value)).toContain('"feature"')
  })

  it("still rejects non-loopback host headers on control routes", async () => {
    const { control, calls } = fakeControl()
    const base = startServer(control)

    const response = await fetch(`${base}/sessions/ses_abc/enabled`, {
      method: "POST",
      headers: { host: `evil.example.com:${TEST_PORT}`, "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    })

    expect(response.status).toBe(403)
    expect(calls).toEqual([])
  })
})

const PANEL_PORT = TEST_PORT + 3

function panelChrome(): PanelChrome {
  return {
    pageTitle: "CI Loop",
    emptyWaiting: "Waiting for a push with CI…",
    noMatches: "No session matches the current filters.",
    searchPlaceholder: "Search sessions…",
    filtersLabel: "Filters",
    filterEnabledAll: "watch: all",
    filterEnabledOn: "watch: on",
    filterEnabledOff: "watch: off",
    watchOn: "watch on",
    watchOff: "watch off",
    clearFilters: "clear",
    hiddenTemplate: "{n} hidden by filters",
    phaseChips: {
      waiting: "waiting",
      running: "running",
      "done-green": "green",
      "done-failed": "failed",
      reviewing: "reviewing",
      "review-ended": "review ended",
      "timed-out": "timed out",
      error: "error",
    },
  }
}

function panelSessionOf(state: SessionState): PanelSession {
  return {
    sessionID: state.sessionID,
    title: "Fix the CI loop",
    projectLabel: "repo",
    directory: state.directory,
    enabled: state.enabled,
    watches: [],
    searchText: "fix the ci loop",
  }
}

const fakeMapper: PanelMapper = (sessions) => ({
  chrome: panelChrome(),
  sessions: sessions.map(panelSessionOf),
})

async function readSseFrame(url: string): Promise<unknown> {
  const response = await fetch(url)
  const reader = response.body?.getReader()
  const chunk = await reader?.read()
  await reader?.cancel()
  const text = new TextDecoder().decode(chunk?.value)
  return JSON.parse(text.replace(/^data: /, "").trim())
}

describe("DashboardServer panel routes", () => {
  let server: DashboardServer | null = null

  afterEach(() => {
    server?.stop()
    server = null
  })

  function startServer(mapper?: PanelMapper): string {
    server = new DashboardServer({ enabled: true, host: "127.0.0.1", port: PANEL_PORT }, noopLog)
    if (mapper) server.setPanelMapper(mapper)
    server.start()
    return `http://127.0.0.1:${PANEL_PORT}`
  }

  it("GET /panel/state returns the mapped panel snapshot", async () => {
    const base = startServer(fakeMapper)
    const state: SessionState = {
      sessionID: "ses_panel" as SessionId,
      enabled: true,
      watches: [],
      watch: null,
      directory: "/repo",
    }
    server?.broadcast([state])

    const response = await fetch(`${base}/panel/state`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      chrome: panelChrome(),
      sessions: [panelSessionOf(state)],
    } satisfies PanelSnapshot)
  })

  it("GET /panel/events streams the panel snapshot, not SessionState[]", async () => {
    const base = startServer(fakeMapper)
    const watch = waitingWatch("feature")
    server?.broadcast([
      {
        sessionID: "ses_panel_sse" as SessionId,
        enabled: true,
        watches: [watch],
        watch,
        directory: "/repo",
      },
    ])

    const frame = await readSseFrame(`${base}/panel/events`)

    expect(Array.isArray(frame)).toBe(false)
    const panel = frame as PanelSnapshot
    expect(panel.chrome.pageTitle).toBe("CI Loop")
    expect(panel.sessions.map((session) => session.sessionID)).toEqual(["ses_panel_sse"])
    expect(JSON.stringify(frame)).not.toContain('"watches":[{')
  })

  it("falls back to an empty panel snapshot when no mapper is wired", async () => {
    const base = startServer()
    server?.broadcast([sessionState("ses_nomapper", true)])

    const panel = (await (await fetch(`${base}/panel/state`)).json()) as PanelSnapshot

    expect(panel.sessions).toEqual([])
    expect(panel.chrome.pageTitle).toBeTruthy()
    expect(panel.chrome.hiddenTemplate).toContain("{n}")
    for (const key of PANEL_PHASE_KEYS) expect(panel.chrome.phaseChips[key]).toBeTruthy()
  })

  it("rejects non-loopback host headers on /panel routes", async () => {
    const base = startServer(fakeMapper)
    const headers = { host: `evil.example.com:${PANEL_PORT}` }

    const state = await fetch(`${base}/panel/state`, { headers })
    const events = await fetch(`${base}/panel/events`, { headers })

    expect(state.status).toBe(403)
    expect(events.status).toBe(403)
  })

  it("GET /state still returns a bare SessionState[] array with the original fields", async () => {
    const base = startServer(fakeMapper)
    const watch = waitingWatch("feature")
    server?.broadcast([
      {
        sessionID: "ses_compat" as SessionId,
        enabled: true,
        watches: [watch],
        watch,
        directory: "/repo",
      },
    ])

    const body = await (await fetch(`${base}/state`)).json()

    expect(Array.isArray(body)).toBe(true)
    const [first] = body as ReadonlyArray<Partial<SessionState>>
    expect(Object.keys(first ?? {}).sort()).toEqual(["directory", "enabled", "sessionID", "watch", "watches"])
    expect(first?.sessionID).toBe("ses_compat" as SessionId)
  })

  it("GET /events still streams SessionState[] after a panel mapper is wired", async () => {
    const base = startServer(fakeMapper)
    const watch = waitingWatch("feature")
    server?.broadcast([
      {
        sessionID: "ses_events_compat" as SessionId,
        enabled: true,
        watches: [watch],
        watch,
        directory: "/repo",
      },
    ])

    const frame = await readSseFrame(`${base}/events`)

    expect(Array.isArray(frame)).toBe(true)
    const sessions = frame as ReadonlyArray<Partial<SessionState>>
    expect(Object.keys(sessions[0] ?? {}).sort()).toEqual([
      "directory",
      "enabled",
      "sessionID",
      "watch",
      "watches",
    ])
    expect(JSON.stringify(frame)).not.toContain("chrome")
  })

  it("broadcast() keeps its single-argument signature", () => {
    expect(DashboardServer.prototype.broadcast.length).toBe(1)
  })
})

describe("DashboardServer bind conflict", () => {
  const servers: DashboardServer[] = []
  let foreign: ReturnType<typeof Bun.serve> | null = null
  let consoleSpies: ReturnType<typeof spyOn>[] = []

  const FAST_TUNING: BindTuning = { retryMs: 20, foreignProbesBeforeLog: 3, probeTimeoutMs: 500 }

  function silenceConsole(): void {
    consoleSpies = (["warn", "error", "log", "info", "debug"] as const).map((method) =>
      spyOn(console, method).mockImplementation(() => {}),
    )
  }

  function dashboardOn(port: number, tuning: BindTuning = FAST_TUNING): Array<[LogLevel, string]> {
    const logs: Array<[LogLevel, string]> = []
    const server = new DashboardServer(
      { enabled: true, host: "127.0.0.1", port },
      (level, message) => logs.push([level, message]),
      tuning,
    )
    servers.push(server)
    server.start()
    return logs
  }

  afterEach(() => {
    for (const server of servers.splice(0)) server.stop()
    foreign?.stop(true)
    foreign = null
    for (const spy of consoleSpies.splice(0)) spy.mockRestore()
  })

  it("stays silent when a sibling dashboard owns the port", async () => {
    const port = TEST_PORT + 1
    dashboardOn(port)
    const logs = dashboardOn(port)

    await Bun.sleep(400)

    expect(logs).toEqual([])
  })

  it("logs once when a foreign process owns the port", async () => {
    const port = TEST_PORT + 2
    foreign = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("ok") })
    const logs = dashboardOn(port)

    await Bun.sleep(400)

    expect(logs).toHaveLength(1)
    expect(logs[0]?.[0]).toBe("warn")
    expect(logs[0]?.[1]).toContain(`port ${port} in use by another process`)
  })

  it("never touches console, which would corrupt the TUI frame", async () => {
    silenceConsole()
    const port = TEST_PORT + 4
    foreign = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("ok") })
    const logs = dashboardOn(port)

    await Bun.sleep(400)

    expect(logs).toHaveLength(1)
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled()
  })

  it("holds the warning on the first probe, when opencode's boot starves it", async () => {
    const port = TEST_PORT + 5
    foreign = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("ok") })
    const logs = dashboardOn(port, { ...FAST_TUNING, retryMs: 60_000 })

    await Bun.sleep(400)

    expect(logs).toEqual([])
  })

  it("never slanders a sibling that only sometimes answers in time", async () => {
    const port = TEST_PORT + 6
    let probes = 0
    foreign = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: () => {
        probes += 1
        const answersMarker = probes % 3 === 0
        return new Response(null, { headers: answersMarker ? { "x-ci-loop": "dashboard" } : {} })
      },
    })
    const logs = dashboardOn(port)

    await Bun.sleep(500)

    expect(probes).toBeGreaterThan(3)
    expect(logs).toEqual([])
  })
})
