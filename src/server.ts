import { z } from "zod"
import { DASHBOARD_HTML } from "./dashboard.ts"
import type { PluginConfig, SessionState } from "./types.ts"

type SseClient = {
  readonly controller: ReadableStreamDefaultController<Uint8Array>
}

/** Controle externo (OpenChamber) do toggle por sessão. `getSession` é leitura pura. */
export type SessionControl = {
  readonly getSession: (sessionID: string) => SessionState
  readonly setEnabled: (sessionID: string, enabled: boolean) => SessionState
}

const EnabledBodySchema = z.object({ enabled: z.boolean() })

const SESSION_PATH = /^\/sessions\/([^/]+?)(\/enabled)?$/

/** Mini servidor HTTP+SSE do dashboard. Broadcast de snapshots pros clientes conectados. */
export class DashboardServer {
  private readonly clients = new Set<SseClient>()
  private server: ReturnType<typeof Bun.serve> | null = null
  private lastSnapshot: readonly SessionState[] = []
  private control: SessionControl | null = null

  constructor(private readonly config: PluginConfig["dashboard"]) {}

  get url(): string {
    return `http://${this.config.host}:${this.config.port}`
  }

  setControl(control: SessionControl): void {
    this.control = control
  }

  start(): void {
    if (!this.config.enabled || this.server) return
    this.server = Bun.serve({
      hostname: this.config.host,
      port: this.config.port,
      fetch: (request) => this.route(request),
    })
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
        return Response.json(this.lastSnapshot)
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

/** Barra DNS rebinding: só aceita requests endereçados ao próprio loopback. */
export function isAllowedHost(hostHeader: string | null, port: number): boolean {
  if (hostHeader === null) return false
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]
  return allowed.includes(hostHeader.toLowerCase())
}
