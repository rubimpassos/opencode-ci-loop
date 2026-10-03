/** Comment frame: EventSource ignores it, but it keeps idle proxies and sockets from timing out. */
const PING = new TextEncoder().encode(": ping\n\n")

export const DEFAULT_HEARTBEAT_MS = 5_000

type SseClient<K> = {
  readonly key: K
  readonly controller: ReadableStreamDefaultController<Uint8Array>
  readonly heartbeat: ReturnType<typeof setInterval>
}

/**
 * Set of SSE subscribers keyed by what each one wants to see (e.g. a viewer locale). `publish`
 * renders and encodes each distinct key at most once per call.
 */
export class SseChannel<K> {
  private readonly clients = new Set<SseClient<K>>()

  constructor(private readonly heartbeatMs: number) {}

  open(key: K, initial: unknown): Response {
    const clients = this.clients
    const heartbeatMs = this.heartbeatMs
    let client: SseClient<K> | null = null
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const heartbeat = setInterval(() => {
          if (client) send(clients, client, PING)
        }, heartbeatMs)
        heartbeat.unref?.()
        client = { key, controller, heartbeat }
        clients.add(client)
        controller.enqueue(encodeEvent(initial))
      },
      cancel() {
        if (client) dispose(clients, client)
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

  publish(render: (key: K) => unknown): void {
    const encoded = new Map<K, Uint8Array>()
    for (const client of this.clients) {
      const frame = encoded.get(client.key) ?? encodeEvent(render(client.key))
      encoded.set(client.key, frame)
      send(this.clients, client, frame)
    }
  }

  closeAll(): void {
    for (const client of this.clients) {
      clearInterval(client.heartbeat)
      try {
        client.controller.close()
      } catch (error) {
        if (!(error instanceof Error)) throw error
      }
    }
    this.clients.clear()
  }
}

function send<K>(clients: Set<SseClient<K>>, client: SseClient<K>, frame: Uint8Array): void {
  try {
    client.controller.enqueue(frame)
  } catch (error) {
    if (!(error instanceof Error)) throw error
    dispose(clients, client)
  }
}

function dispose<K>(clients: Set<SseClient<K>>, client: SseClient<K>): void {
  clearInterval(client.heartbeat)
  clients.delete(client)
}

function encodeEvent(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`)
}
