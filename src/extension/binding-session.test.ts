import { describe, expect, it } from "bun:test"
import { HostRequestError } from "@openchamber/sdk"
import { createPanelBinding } from "./binding.ts"
import { fakeClock, fakeHost, flush, snapshot } from "./fake-host.test-support.ts"

function connected() {
  const host = fakeHost()
  const binding = createPanelBinding({ host, locale: "en", schedule: fakeClock().schedule })
  host.watches[0]?.emit({ type: "data", text: JSON.stringify(snapshot("en", "S")) })
  return { host, binding }
}

const session = (sessionID: string, enabled: boolean) => ({
  status: 200,
  body: JSON.stringify({ sessionID, enabled, watches: [], watch: null, directory: null }),
})

describe("panel binding session requests", () => {
  it("reads a session through its encoded path and narrows the response", async () => {
    const { host, binding } = connected()
    const pending = binding.getSession("ses/odd id")
    host.requests[0]?.respond(session("ses/odd id", false))

    expect(await pending).toEqual({ kind: "ok", value: { sessionID: "ses/odd id", enabled: false } })
    expect(host.requests[0]?.call).toEqual({ path: "/sessions/ses%2Fodd%20id", method: "GET" })
  })

  it("supersedes an older lookup of the same session when its response arrives last", async () => {
    const { host, binding } = connected()
    const older = binding.getSession("ses_1")
    const newer = binding.getSession("ses_1")
    host.requests[1]?.respond(session("ses_1", true))
    host.requests[0]?.respond(session("ses_1", false))

    expect(await newer).toEqual({ kind: "ok", value: { sessionID: "ses_1", enabled: true } })
    expect(await older).toEqual({ kind: "superseded" })
  })

  it("drops a lookup whose caller aborted on session change", async () => {
    const { host, binding } = connected()
    const switched = new AbortController()
    const pending = binding.getSession("ses_a", switched.signal)
    switched.abort()
    host.requests[0]?.respond(session("ses_a", true))

    expect(await pending).toEqual({ kind: "superseded" })
  })

  it("posts the toggle as JSON and returns the authoritative state", async () => {
    const { host, binding } = connected()
    const pending = binding.setEnabled("ses_1", false)
    host.requests[0]?.respond(session("ses_1", false))

    expect(host.requests[0]?.call).toEqual({
      path: "/sessions/ses_1/enabled",
      method: "POST",
      body: { enabled: false },
    })
    expect(await pending).toEqual({ kind: "ok", value: { sessionID: "ses_1", enabled: false } })
  })

  it("surfaces a plain-text rejection with its status", async () => {
    const { host, binding } = connected()
    const pending = binding.setEnabled("ses_1", true)
    host.requests[0]?.respond({ status: 400, body: "invalid body" })

    expect(await pending).toEqual({
      kind: "failed",
      failure: { kind: "rejected", status: 400, message: "invalid body" },
    })
  })

  it("maps an unreadable session body to invalid-data", async () => {
    const { host, binding } = connected()
    const pending = binding.getSession("ses_1")
    host.requests[0]?.respond({ status: 200, body: "<html>" })

    expect(await pending).toEqual({ kind: "failed", failure: { kind: "invalid-data", reason: "unreadable" } })
  })

  it("maps a host refusal to forbidden", async () => {
    const { host, binding } = connected()
    const pending = binding.getSession("ses_1")
    host.requests[0]?.reject(new HostRequestError("NOT_GRANTED", "revoked"))

    expect(await pending).toEqual({ kind: "failed", failure: { kind: "forbidden" } })
  })

  it("refuses a toggle without sending it while access is forbidden", async () => {
    const { host, binding } = connected()
    host.watches[0]?.emit({
      type: "connection",
      state: "unavailable",
      error: new HostRequestError("NOT_GRANTED", "x"),
    })

    expect(await binding.setEnabled("ses_1", true)).toEqual({
      kind: "failed",
      failure: { kind: "forbidden" },
    })
    expect(host.requests).toHaveLength(0)
  })

  it("dispose supersedes in-flight requests and closes the stream", async () => {
    const { host, binding } = connected()
    const pending = binding.getSession("ses_1")
    binding.dispose()
    host.requests[0]?.respond(session("ses_1", true))
    await flush()

    expect(await pending).toEqual({ kind: "superseded" })
    expect(host.watches[0]?.disposed).toBe(true)
  })
})
