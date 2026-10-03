import { z } from "zod"
import { DASHBOARD_HTML } from "./dashboard.ts"
import { CATALOGS, LOCALES, type Locale } from "./i18n.ts"
import type { PanelSnapshot } from "./panel-types.ts"
import { buildChrome } from "./panel-view.ts"
import { DEFAULT_HEARTBEAT_MS, SseChannel } from "./sse.ts"
import type { LogSink, PluginConfig, SessionState } from "./types.ts"

/** External control (OpenChamber) of the per-session toggle. `getSession` is a pure read. */
export type SessionControl = {
  readonly getSession: (sessionID: string) => SessionState
  readonly setEnabled: (sessionID: string, enabled: boolean) => SessionState
}

/**
 * Projects the frozen `SessionState[]` snapshot into the panel view model. Injected by the plugin.
 * `locale` is the viewer's `?locale=` override; absent = default per-session localization.
 */
export type PanelMapper = (sessions: readonly SessionState[], locale?: Locale) => PanelSnapshot

/** Served until the plugin wires its mapper; English because no session has claimed a locale yet. */
const EMPTY_PANEL: PanelSnapshot = { chrome: buildChrome(CATALOGS.en), sessions: [] }

const emptyPanelMapper: PanelMapper = (_sessions, locale) =>
  locale === undefined ? EMPTY_PANEL : { chrome: buildChrome(CATALOGS[locale]), sessions: [] }

/** Viewer locale of a panel request: `null` = no override (default mapping). */
type ViewerLocale = Locale | null

/** `undefined` = the supplied `locale` query is not a supported locale (→ 400). */
function parseViewerLocale(url: URL): ViewerLocale | undefined {
  const raw = url.searchParams.get("locale")
  if (raw === null) return null
  return LOCALES.find((locale) => locale === raw)
}

const EnabledBodySchema = z.object({ enabled: z.boolean() })

const SESSION_PATH = /^\/sessions\/([^/]+?)(\/enabled)?$/

const DASHBOARD_MARKER_HEADER = "x-ci-loop"
const DASHBOARD_MARKER_VALUE = "dashboard"
const MARKER_HEADERS = { [DASHBOARD_MARKER_HEADER]: DASHBOARD_MARKER_VALUE } as const

export type BindTuning = {
  readonly retryMs: number
  /**
   * Consecutive probes that must all miss the marker before the owner counts as foreign. A single
   * probe is not evidence: opencode's boot saturates the event loop and a busy sibling can take
   * over a second just to answer, so one timeout would slander a healthy sibling dashboard.
   */
  readonly foreignProbesBeforeLog: number
  readonly probeTimeoutMs: number
}

export const DEFAULT_BIND_TUNING: BindTuning = {
  retryMs: 15_000,
  foreignProbesBeforeLog: 3,
  probeTimeoutMs: 2_000,
}

/** Bind tuning plus the SSE comment-heartbeat period (defaults to 5 s). */
export type ServerTuning = BindTuning & { readonly heartbeatMs?: number }

type BunServer = ReturnType<typeof Bun.serve>

/** Mini servidor HTTP+SSE do dashboard. Broadcast de snapshots pros clientes conectados. */
export class DashboardServer {
  private readonly clients: SseChannel<null>
  private readonly panelClients: SseChannel<ViewerLocale>
  private server: BunServer | null = null
  private lastSnapshot: readonly SessionState[] = []
  /** Panels mapped from `lastSnapshot`, one per viewer locale; cleared on every broadcast. */
  private readonly panels = new Map<ViewerLocale, PanelSnapshot>([[null, EMPTY_PANEL]])
  private control: SessionControl | null = null
  private panelMapper: PanelMapper | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private foreignProbes = 0
  private loggedBindFailure = false

  constructor(
    private readonly config: PluginConfig["dashboard"],
    private readonly log: LogSink,
    private readonly tuning: ServerTuning = DEFAULT_BIND_TUNING,
  ) {
    const heartbeatMs = tuning.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
    this.clients = new SseChannel(heartbeatMs)
    this.panelClients = new SseChannel(heartbeatMs)
  }

  get url(): string {
    return `http://${this.config.host}:${this.config.port}`
  }

  setControl(control: SessionControl): void {
    this.control = control
  }

  setPanelMapper(mapper: PanelMapper): void {
    this.panelMapper = mapper
  }

  /** Tries to bind; port taken (another opencode process) → retry until the owner frees it. */
  start(): void {
    if (!this.config.enabled || this.server) return
    this.stopped = false
    try {
      this.server = Bun.serve({
        hostname: this.config.host,
        port: this.config.port,
        fetch: (request, server) => this.route(request, server),
      })
      this.foreignProbes = 0
    } catch (error) {
      if (!(error instanceof Error)) throw error
      void this.logIfForeignOwner()
      this.scheduleRetry()
    }
  }

  /** Sibling opencode dashboard on the port → silent takeover retry. Foreign process → log once. */
  private async logIfForeignOwner(): Promise<void> {
    if (this.loggedBindFailure) return
    if (await this.portOwnerIsSiblingDashboard()) {
      this.foreignProbes = 0
      return
    }
    this.foreignProbes += 1
    if (this.foreignProbes < this.tuning.foreignProbesBeforeLog) return
    if (this.loggedBindFailure) return
    this.loggedBindFailure = true
    this.log(
      "warn",
      `port ${this.config.port} in use by another process; retrying to take it over every ${this.tuning.retryMs}ms`,
    )
  }

  private async portOwnerIsSiblingDashboard(): Promise<boolean> {
    try {
      // HEAD: the marker lives in the headers, and a busy owner can blow the probe budget just
      // serializing its (hundreds of KB) `/state` body.
      const response = await fetch(`${this.url}/state`, {
        method: "HEAD",
        signal: AbortSignal.timeout(this.tuning.probeTimeoutMs),
      })
      return response.headers.get(DASHBOARD_MARKER_HEADER) === DASHBOARD_MARKER_VALUE
    } catch (error) {
      if (!(error instanceof Error)) throw error
      return false
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return
    const timer = setTimeout(() => {
      this.retryTimer = null
      this.start()
    }, this.tuning.retryMs)
    timer.unref?.()
    this.retryTimer = timer
  }

  private async route(request: Request, server: BunServer): Promise<Response> {
    if (!isAllowedHost(request.headers.get("host"), this.config.port)) {
      return new Response("forbidden", { status: 403 })
    }
    const url = new URL(request.url)
    const path = url.pathname
    const sessionMatch = path.match(SESSION_PATH)
    const sessionID = sessionMatch?.[1]
    if (sessionID !== undefined) {
      return this.controlRoute(request, decodeURIComponent(sessionID), Boolean(sessionMatch?.[2]))
    }
    switch (path) {
      case "/":
        return new Response(DASHBOARD_HTML, { headers: { "content-type": "text/html; charset=utf-8" } })
      case "/state":
        return request.method === "HEAD"
          ? new Response(null, { headers: MARKER_HEADERS })
          : Response.json(this.lastSnapshot, { headers: MARKER_HEADERS })
      case "/events":
        server.timeout(request, 0)
        return this.clients.open(null, this.lastSnapshot)
      case "/panel/state":
      case "/panel/events": {
        const locale = parseViewerLocale(url)
        if (locale === undefined) return new Response("invalid locale", { status: 400 })
        if (path === "/panel/state") return Response.json(this.panelFor(locale))
        server.timeout(request, 0)
        return this.panelClients.open(locale, this.panelFor(locale))
      }
      default:
        return new Response("not found", { status: 404 })
    }
  }

  private async controlRoute(request: Request, sessionID: string, isEnabledPath: boolean): Promise<Response> {
    const control = this.control
    if (!control) return new Response("not found", { status: 404 })
    if (isEnabledPath) {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 })
      const parsed = EnabledBodySchema.safeParse(await request.json().catch(() => null))
      if (!parsed.success) return new Response("invalid body", { status: 400 })
      return Response.json(control.setEnabled(sessionID, parsed.data.enabled))
    }
    if (request.method !== "GET") return new Response("method not allowed", { status: 405 })
    return Response.json(control.getSession(sessionID))
  }

  broadcast(snapshot: readonly SessionState[]): void {
    this.lastSnapshot = snapshot
    this.panels.clear()
    this.panelFor(null)
    this.clients.publish(() => snapshot)
    this.panelClients.publish((locale) => this.panelFor(locale))
  }

  /** Maps `lastSnapshot` at most once per viewer locale between broadcasts. */
  private panelFor(locale: ViewerLocale): PanelSnapshot {
    const cached = this.panels.get(locale)
    if (cached) return cached
    const mapper = this.panelMapper ?? emptyPanelMapper
    const panel = locale === null ? mapper(this.lastSnapshot) : mapper(this.lastSnapshot, locale)
    this.panels.set(locale, panel)
    return panel
  }

  stop(): void {
    this.stopped = true
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.clients.closeAll()
    this.panelClients.closeAll()
    this.server?.stop(true)
    this.server = null
  }
}

/** Blocks DNS rebinding: only accepts requests addressed to loopback itself. */
export function isAllowedHost(hostHeader: string | null, port: number): boolean {
  if (hostHeader === null) return false
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]
  return allowed.includes(hostHeader.toLowerCase())
}
