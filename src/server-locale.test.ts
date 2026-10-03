import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { CATALOGS, type Locale } from "./i18n.ts"
import type { PanelSnapshot } from "./panel-types.ts"
import { buildPanelSnapshot, type PanelDeps } from "./panel-view.ts"
import { DashboardServer, type PanelMapper } from "./server.ts"
import type { CiReport, CommitSha, SessionId, SessionState, Watch } from "./types.ts"

const BLOCKED_REPORT: CiReport = {
  sha: "abcdef1234567890" as CommitSha,
  branch: "feat/locale",
  repo: "github.com/o/r",
  sourceKind: "session",
  directory: "/repo",
  runs: [],
  failedLogs: [],
  pr: {
    number: 7,
    title: "locale",
    url: "https://github.com/o/r/pull/7",
    isDraft: false,
    state: "OPEN",
    mergeable: "MERGEABLE",
    mergeStateStatus: "BLOCKED",
    reviewDecision: "APPROVED",
    commitCount: 1,
    checks: [],
  },
  ruleFailures: [],
  review: null,
}

function session(id: string, startedAt: number): SessionState {
  const watch: Watch = {
    sha: "abcdef1234567890" as CommitSha,
    branch: `feat/${id}`,
    repo: "github.com/o/r",
    repoUrl: "https://github.com/o/r",
    directory: "/repo",
    sourceKind: "session",
    startedAt,
    phase: { kind: "done", report: BLOCKED_REPORT },
  }
  return { sessionID: id as SessionId, enabled: true, watches: [watch], watch, directory: "/repo" }
}

const SESSION_LOCALES = new Map<SessionId, Locale>([
  ["ses_en" as SessionId, "en"],
  ["ses_pt" as SessionId, "pt-BR"],
])

/** ses_pt owns the newest watch, so the default chrome is pt-BR while ses_en stays English. */
const SESSIONS = [session("ses_en", 1), session("ses_pt", 2)]

/** The plugin's wiring shape: the viewer override is forwarded into `PanelDeps.locale`. */
function recordingMapper(): { readonly mapper: PanelMapper; readonly calls: string[] } {
  const calls: string[] = []
  const deps: PanelDeps = { language: "auto", locales: SESSION_LOCALES, titles: new Map() }
  const mapper: PanelMapper = (sessions, locale) => {
    calls.push(locale ?? "default")
    return buildPanelSnapshot(sessions, locale === undefined ? deps : { ...deps, locale })
  }
  return { mapper, calls }
}

function blockersOf(panel: PanelSnapshot): readonly (readonly string[] | undefined)[] {
  return panel.sessions.map((row) => row.watches[0]?.pr?.blockers)
}

type ChunkReader = { read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }> }

/** Incremental SSE frame reader over a real socket. */
class SseReader {
  private buffer = ""
  private constructor(
    private readonly reader: ChunkReader,
    private readonly abort: AbortController,
  ) {}

  static async open(url: string): Promise<SseReader> {
    const abort = new AbortController()
    const response = await fetch(url, { signal: abort.signal })
    expect(response.status).toBe(200)
    if (response.body === null) throw new Error("SSE response without body")
    return new SseReader(response.body.getReader(), abort)
  }

  private async frame(): Promise<string> {
    for (let end = this.buffer.indexOf("\n\n"); end < 0; end = this.buffer.indexOf("\n\n")) {
      const chunk = await this.reader.read()
      if (chunk.done) throw new Error("SSE stream ended")
      this.buffer += new TextDecoder().decode(chunk.value)
    }
    const end = this.buffer.indexOf("\n\n")
    const frame = this.buffer.slice(0, end)
    this.buffer = this.buffer.slice(end + 2)
    return frame
  }

  /** Next `data:` payload; comment frames in between are skipped. */
  async next(): Promise<unknown> {
    for (let frame = await this.frame(); ; frame = await this.frame()) {
      if (!frame.startsWith(":")) return JSON.parse(frame.replace(/^data: /, ""))
    }
  }

  async nextPanel(): Promise<PanelSnapshot> {
    return (await this.next()) as PanelSnapshot
  }

  /** Waits for a `: ping` comment; call only while no data frame is pending. */
  async untilPing(): Promise<void> {
    expect(await this.frame()).toBe(": ping")
  }

  /** Drops the socket like a closing EventSource; a bare reader cancel keeps Bun's connection open. */
  disconnect(): void {
    this.abort.abort()
  }
}

function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") })
  const port = probe.port
  probe.stop(true)
  if (port === undefined) throw new Error("no free port")
  return port
}

describe("DashboardServer viewer locale", () => {
  let server: DashboardServer | null = null
  const readers: SseReader[] = []

  afterEach(() => {
    for (const reader of readers.splice(0)) reader.disconnect()
    server?.stop()
    server = null
  })

  function start(mapper?: PanelMapper, heartbeatMs = 60_000): string {
    const port = freePort()
    server = new DashboardServer({ enabled: true, host: "127.0.0.1", port }, () => {}, {
      retryMs: 60_000,
      foreignProbesBeforeLog: 3,
      probeTimeoutMs: 500,
      heartbeatMs,
    })
    if (mapper) server.setPanelMapper(mapper)
    server.start()
    return `http://127.0.0.1:${port}`
  }

  async function viewer(base: string, query: string, route = "/panel/events"): Promise<SseReader> {
    const reader = await SseReader.open(`${base}${route}${query}`)
    readers.push(reader)
    return reader
  }

  it("serves en, pt-BR and default viewers their own payload across two broadcasts", async () => {
    const { mapper } = recordingMapper()
    const base = start(mapper)
    const en = await viewer(base, "?locale=en")
    const pt = await viewer(base, "?locale=pt-BR")
    const auto = await viewer(base, "")
    await Promise.all([en.next(), pt.next(), auto.next()])

    for (const sessions of [SESSIONS, [...SESSIONS].reverse()]) {
      server?.broadcast(sessions)
      const [enPanel, ptPanel, autoPanel] = await Promise.all([
        en.nextPanel(),
        pt.nextPanel(),
        auto.nextPanel(),
      ])
      expect(enPanel.chrome.noMatches).toBe(CATALOGS.en.panelNoMatches)
      expect(new Set(blockersOf(enPanel).flat())).toEqual(new Set([CATALOGS.en.blockerBranchProtection]))
      expect(ptPanel.chrome.noMatches).toBe(CATALOGS["pt-BR"].panelNoMatches)
      expect(new Set(blockersOf(ptPanel).flat())).toEqual(
        new Set([CATALOGS["pt-BR"].blockerBranchProtection]),
      )
      expect(autoPanel.chrome.noMatches).toBe(CATALOGS["pt-BR"].panelNoMatches)
      const autoRows = new Map(autoPanel.sessions.map((row) => [row.sessionID, row.watches[0]?.pr?.blockers]))
      expect(autoRows.get("ses_en")).toEqual([CATALOGS.en.blockerBranchProtection])
      expect(autoRows.get("ses_pt")).toEqual([CATALOGS["pt-BR"].blockerBranchProtection])
    }
  })

  it("maps each viewer locale at most once per broadcast, however many viewers share it", async () => {
    const { mapper, calls } = recordingMapper()
    const base = start(mapper)
    const streams = await Promise.all(
      ["?locale=en", "?locale=en", "?locale=pt-BR", "", ""].map((query) => viewer(base, query)),
    )
    await Promise.all(streams.map((stream) => stream.next()))
    calls.length = 0

    server?.broadcast(SESSIONS)
    await Promise.all(streams.map((stream) => stream.next()))

    expect([...calls].sort()).toEqual(["default", "en", "pt-BR"])
  })

  it("serves a reconnecting viewer its locale's initial frame without remapping", async () => {
    const { mapper, calls } = recordingMapper()
    const base = start(mapper)
    server?.broadcast(SESSIONS)
    calls.length = 0

    const first = await (await viewer(base, "?locale=en")).nextPanel()
    const reconnect = await (await viewer(base, "?locale=en")).nextPanel()
    const state = (await (await fetch(`${base}/panel/state?locale=en`)).json()) as PanelSnapshot

    expect(first.chrome.noMatches).toBe(CATALOGS.en.panelNoMatches)
    expect(reconnect).toEqual(first)
    expect(state).toEqual(first)
    expect(calls).toEqual(["en"])
  })

  it("keeps the default mapping when no locale is supplied", async () => {
    const { mapper, calls } = recordingMapper()
    const base = start(mapper)
    server?.broadcast(SESSIONS)

    const panel = (await (await fetch(`${base}/panel/state`)).json()) as PanelSnapshot

    expect(panel).toEqual(
      buildPanelSnapshot(SESSIONS, { language: "auto", locales: SESSION_LOCALES, titles: new Map() }),
    )
    expect(calls).toEqual(["default"])
  })

  it.each(["xx", "", "PT-BR", "pt"])("rejects ?locale=%j with 400 on both panel routes", async (locale) => {
    const base = start(recordingMapper().mapper)
    const query = `?locale=${encodeURIComponent(locale)}`

    const state = await fetch(`${base}/panel/state${query}`)
    const events = await fetch(`${base}/panel/events${query}`)

    expect(state.status).toBe(400)
    expect(events.status).toBe(400)
  })

  it("still answers 403 to a foreign Host before parsing the locale", async () => {
    const base = start(recordingMapper().mapper)
    const headers = { host: "evil.example.com" }

    const valid = await fetch(`${base}/panel/state?locale=en`, { headers })
    const invalid = await fetch(`${base}/panel/events?locale=xx`, { headers })

    expect(valid.status).toBe(403)
    expect(invalid.status).toBe(403)
  })

  it("leaves the raw /state and /events contract untouched by a locale query", async () => {
    const base = start(recordingMapper().mapper)
    server?.broadcast(SESSIONS)
    const expected = JSON.parse(JSON.stringify(SESSIONS))

    const state = await (await fetch(`${base}/state?locale=pt-BR`)).json()
    const events = await (await viewer(base, "?locale=xx", "/events")).next()

    expect(state).toEqual(expected)
    expect(events).toEqual(expected)
  })

  it("sends comment heartbeats on panel and raw streams while data frames stay plain JSON", async () => {
    const base = start(recordingMapper().mapper, 20)
    const panel = await viewer(base, "?locale=pt-BR")
    const raw = await viewer(base, "", "/events")
    await Promise.all([panel.next(), raw.next()])

    await Promise.all([panel.untilPing(), raw.untilPing()])
    server?.broadcast(SESSIONS)

    expect(Array.isArray(await raw.next())).toBe(true)
    expect((await panel.nextPanel()).chrome.noMatches).toBe(CATALOGS["pt-BR"].panelNoMatches)
  })

  it("disposes heartbeat timers when a client disconnects and when the server stops", async () => {
    const setSpy = spyOn(globalThis, "setInterval")
    const clearSpy = spyOn(globalThis, "clearInterval")
    try {
      const base = start(recordingMapper().mapper, 20)
      const leaving = await SseReader.open(`${base}/panel/events?locale=en`)
      await leaving.next()
      const staying = await viewer(base, "", "/events")
      await staying.next()
      const [leavingTimer, stayingTimer] = setSpy.mock.results.map((result) => result.value)

      const cleared = (timer: unknown): boolean => clearSpy.mock.calls.some(([call]) => call === timer)
      leaving.disconnect()
      // The server learns of the disconnect asynchronously and offers no event to await: bounded wait.
      for (let waited = 0; waited < 1_000 && !cleared(leavingTimer); waited += 10) await Bun.sleep(10)
      expect(cleared(leavingTimer)).toBe(true)
      expect(cleared(stayingTimer)).toBe(false)

      server?.stop()
      expect(cleared(stayingTimer)).toBe(true)
    } finally {
      setSpy.mockRestore()
      clearSpy.mockRestore()
    }
  })
})
