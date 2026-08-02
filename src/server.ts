import { z } from "zod"
import { DASHBOARD_HTML } from "./dashboard.ts"
import { CATALOGS } from "./i18n.ts"
import type { PanelSnapshot } from "./panel-types.ts"
import { buildChrome } from "./panel-view.ts"
import type { LogSink, PluginConfig, SessionState } from "./types.ts"

type SseClient = {
  readonly controller: ReadableStreamDefaultController<Uint8Array>
}

/** External control (OpenChamber) of the per-session toggle. `getSession` is a pure read. */
export type SessionControl = {
  readonly getSession: (sessionID: string) => SessionState
  readonly setEnabled: (sessionID: string, enabled: boolean) => SessionState
}

/** Projects the frozen `SessionState[]` snapshot into the panel view model. Injected by the plugin. */
export type PanelMapper = (sessions: readonly SessionState[]) => PanelSnapshot

/** Served until the plugin wires its mapper; English because no session has claimed a locale yet. */
const EMPTY_PANEL: PanelSnapshot = { chrome: buildChrome(CATALOGS.en), sessions: [] }

const emptyPanelMapper: PanelMapper = () => EMPTY_PANEL

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

/** Mini servidor HTTP+SSE do dashboard. Broadcast de snapshots pros clientes conectados. */
export class DashboardServer {
  private readonly clients = new Set<SseClient>()
  private readonly panelClients = new Set<SseClient>()
  private server: ReturnType<typeof Bun.serve> | null = null
  private lastSnapshot: readonly SessionState[] = []
  private lastPanel: PanelSnapshot = EMPTY_PANEL
  private control: SessionControl | null = null
  private panelMapper: PanelMapper | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private foreignProbes = 0
  private loggedBindFailure = false

  constructor(
    private readonly config: PluginConfig["dashboard"],
    private readonly log: LogSink,
    private readonly tuning: BindTuning = DEFAULT_BIND_TUNING,
  ) {}

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
        fetch: (request) => this.route(request),
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

  private async route(request: Request): Promise<Response> {
    if (!isAllowedHost(request.headers.get("host"), this.config.port)) {
      return new Response("forbidden", { status: 403 })
    }
    const path = new URL(request.url).pathname
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
        return this.streamTo(this.clients, this.lastSnapshot)
      case "/panel/state":
        return Response.json(this.lastPanel)
      case "/panel/events":
        return this.streamTo(this.panelClients, this.lastPanel)
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
    this.lastPanel = (this.panelMapper ?? emptyPanelMapper)(snapshot)
    pushTo(this.clients, snapshot)
    pushTo(this.panelClients, this.lastPanel)
  }

  stop(): void {
    this.stopped = true
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    closeAll(this.clients)
    closeAll(this.panelClients)
    this.server?.stop(true)
    this.server = null
  }

  private streamTo(clients: Set<SseClient>, initial: unknown): Response {
    let client: SseClient | null = null
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        client = { controller }
        clients.add(client)
        controller.enqueue(encodeEvent(initial))
      },
      cancel() {
        if (client) clients.delete(client)
      },
    })
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    })
  }
}

function pushTo(clients: Set<SseClient>, payload: unknown): void {
  const encoded = encodeEvent(payload)
  for (const client of clients) {
    try {
      client.controller.enqueue(encoded)
    } catch (error) {
      if (error instanceof Error) {
        clients.delete(client)
      } else {
        throw error
      }
    }
  }
}

function closeAll(clients: Set<SseClient>): void {
  for (const client of clients) {
    try {
      client.controller.close()
    } catch (error) {
      if (!(error instanceof Error)) throw error
    }
  }
  clients.clear()
}

function encodeEvent(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`)
}

/** Blocks DNS rebinding: only accepts requests addressed to loopback itself. */
export function isAllowedHost(hostHeader: string | null, port: number): boolean {
  if (hostHeader === null) return false
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]
  return allowed.includes(hostHeader.toLowerCase())
}
