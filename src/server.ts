import { z } from "zod"
import { DASHBOARD_HTML } from "./dashboard.ts"
import type { PluginConfig, SessionState } from "./types.ts"

type SseClient = {
  readonly controller: ReadableStreamDefaultController<Uint8Array>
}

/** External control (OpenChamber) of the per-session toggle. `getSession` is a pure read. */
export type SessionControl = {
  readonly getSession: (sessionID: string) => SessionState
  readonly setEnabled: (sessionID: string, enabled: boolean) => SessionState
}

const EnabledBodySchema = z.object({ enabled: z.boolean() })

const SESSION_PATH = /^\/sessions\/([^/]+?)(\/enabled)?$/

const BIND_RETRY_MS = 15_000

const DASHBOARD_MARKER_HEADER = "x-ci-loop"
const DASHBOARD_MARKER_VALUE = "dashboard"
const PROBE_TIMEOUT_MS = 1_000

/** Mini servidor HTTP+SSE do dashboard. Broadcast de snapshots pros clientes conectados. */
export class DashboardServer {
  private readonly clients = new Set<SseClient>()
  private server: ReturnType<typeof Bun.serve> | null = null
  private lastSnapshot: readonly SessionState[] = []
  private control: SessionControl | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private warnedBindFailure = false

  constructor(private readonly config: PluginConfig["dashboard"]) {}

  get url(): string {
    return `http://${this.config.host}:${this.config.port}`
  }

  setControl(control: SessionControl): void {
    this.control = control
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
    } catch (error) {
      if (!(error instanceof Error)) throw error
      void this.warnIfForeignOwner()
      this.scheduleRetry()
    }
  }

  /** Sibling opencode dashboard on the port → silent takeover retry. Foreign process → warn once. */
  private async warnIfForeignOwner(): Promise<void> {
    if (this.warnedBindFailure) return
    if (await this.portOwnerIsSiblingDashboard()) return
    if (this.warnedBindFailure) return
    this.warnedBindFailure = true
    console.warn(
      `[ci-loop] port ${this.config.port} in use by another process; retrying to take it over every ${BIND_RETRY_MS}ms`,
    )
  }

  private async portOwnerIsSiblingDashboard(): Promise<boolean> {
    try {
      const response = await fetch(`${this.url}/state`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
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
    }, BIND_RETRY_MS)
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
        return Response.json(this.lastSnapshot, {
          headers: { [DASHBOARD_MARKER_HEADER]: DASHBOARD_MARKER_VALUE },
        })
      case "/events":
        return this.sse()
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
    const payload = encodeEvent(snapshot)
    for (const client of this.clients) {
      try {
        client.controller.enqueue(payload)
      } catch (error) {
        if (error instanceof Error) {
          this.clients.delete(client)
        } else {
          throw error
        }
      }
    }
  }

  stop(): void {
    this.stopped = true
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    for (const client of this.clients) {
      try {
        client.controller.close()
      } catch (error) {
        if (!(error instanceof Error)) throw error
      }
    }
    this.clients.clear()
    this.server?.stop(true)
    this.server = null
  }

  private sse(): Response {
    const clients = this.clients
    const snapshot = this.lastSnapshot
    let client: SseClient | null = null
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        client = { controller }
        clients.add(client)
        controller.enqueue(encodeEvent(snapshot))
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

function encodeEvent(snapshot: readonly SessionState[]): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(snapshot)}\n\n`)
}

/** Blocks DNS rebinding: only accepts requests addressed to loopback itself. */
export function isAllowedHost(hostHeader: string | null, port: number): boolean {
  if (hostHeader === null) return false
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]
  return allowed.includes(hostHeader.toLowerCase())
}
