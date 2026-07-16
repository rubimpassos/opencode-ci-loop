import { afterEach, describe, expect, it } from "bun:test"
import { DashboardServer, isAllowedHost, type SessionControl } from "./server.ts"
import type { SessionId, SessionState } from "./types.ts"

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

const TEST_PORT = 45917

function sessionState(id: string, enabled: boolean): SessionState {
  return { sessionID: id as SessionId, enabled, watch: null, directory: null }
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
    server = new DashboardServer({ enabled: true, host: "127.0.0.1", port: TEST_PORT })
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
