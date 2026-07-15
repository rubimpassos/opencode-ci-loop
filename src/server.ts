import { DASHBOARD_HTML } from "./dashboard.ts"
import type { PluginConfig, SessionState } from "./types.ts"

type SseClient = {
  readonly controller: ReadableStreamDefaultController<Uint8Array>
}

/** Mini servidor HTTP+SSE do dashboard. Broadcast de snapshots pros clientes conectados. */
export class DashboardServer {
  private readonly clients = new Set<SseClient>()
  private server: ReturnType<typeof Bun.serve> | null = null
  private lastSnapshot: readonly SessionState[] = []

  constructor(private readonly config: PluginConfig["dashboard"]) {}

  get url(): string {
    return `http://${this.config.host}:${this.config.port}`
  }

  start(): void {
    if (!this.config.enabled || this.server) return
    this.server = Bun.serve({
      hostname: this.config.host,
      port: this.config.port,
      fetch: (request) => this.route(request),
    })
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

  private route(request: Request): Response {
    const path = new URL(request.url).pathname
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
