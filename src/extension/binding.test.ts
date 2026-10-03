import { describe, expect, it } from "bun:test"
import { HostRequestError } from "@openchamber/sdk"
import { createPanelBinding, POLL_INTERVAL_MS } from "./binding.ts"
import { fakeClock, fakeHost, flush, snapshot } from "./fake-host.test-support.ts"

const json = (value: unknown): string => JSON.stringify(value)

function liveBinding() {
  const host = fakeHost()
  const clock = fakeClock()
  const binding = createPanelBinding({ host, locale: "en", schedule: clock.schedule })
  return { host, clock, binding }
}

describe("panel binding stream", () => {
  it("subscribes to /panel/events with the viewer locale and shows a parsed snapshot as live", () => {
    const { host, binding } = liveBinding()
    host.watches[0]?.emit({ type: "connection", state: "live" })
    host.watches[0]?.emit({ type: "data", text: json(snapshot("en", "Fix CI")) })

    expect(host.watches[0]?.request).toEqual({ path: "/panel/events", query: { locale: "en" } })
    expect(binding.state().connection).toEqual({ kind: "live" })
    expect(binding.state().snapshot?.sessions[0]?.title).toBe("Fix CI")
    expect(binding.state().stale).toBe(false)
  })

  it("reports unreadable JSON as invalid-data and keeps the last snapshot as stale", () => {
    const { host, binding } = liveBinding()
    host.watches[0]?.emit({ type: "data", text: json(snapshot("en", "Fix CI")) })
    host.watches[0]?.emit({ type: "data", text: "{not json" })

    expect(binding.state().connection).toEqual({ kind: "invalid-data", reason: "unreadable" })
    expect(binding.state().snapshot?.sessions[0]?.title).toBe("Fix CI")
    expect(binding.state().stale).toBe(true)
  })

  it("reports a snapshot from a plugin without `failed` as update-required, not an empty dashboard", () => {
    const { host, binding } = liveBinding()
    const old = snapshot("en", "Old")
    const legacy = {
      ...old,
      sessions: old.sessions.map((s) => ({ ...s, watches: s.watches.map(({ failed: _f, ...w }) => w) })),
    }
    host.watches[0]?.emit({ type: "data", text: json(legacy) })

    expect(binding.state().connection).toEqual({ kind: "invalid-data", reason: "update-required" })
    expect(binding.state().snapshot).toBeNull()
  })

  it("marks data stale while offline and fresh again once the stream recovers", () => {
    const { host, binding } = liveBinding()
    const watch = host.watches[0]
    watch?.emit({ type: "data", text: json(snapshot("en", "One")) })
    watch?.emit({
      type: "connection",
      state: "unavailable",
      error: new HostRequestError("DISCONNECTED", "x"),
    })
    const offline = binding.state()
    watch?.emit({ type: "connection", state: "connecting" })
    watch?.emit({ type: "connection", state: "live" })
    watch?.emit({ type: "data", text: json(snapshot("en", "Two")) })

    expect(offline).toMatchObject({ connection: { kind: "unavailable", code: "DISCONNECTED" }, stale: true })
    expect(binding.state()).toMatchObject({ connection: { kind: "live" }, stale: false })
    expect(binding.state().snapshot?.sessions[0]?.title).toBe("Two")
  })

  it("maps a NOT_GRANTED refusal to forbidden", () => {
    const { host, binding } = liveBinding()
    host.watches[0]?.emit({
      type: "connection",
      state: "unavailable",
      error: new HostRequestError("NOT_GRANTED", "x"),
    })

    expect(binding.state().connection).toEqual({ kind: "forbidden" })
  })

  it("re-subscribes with the new locale and ignores events from the old stream", () => {
    const { host, binding } = liveBinding()
    const first = host.watches[0]
    first?.emit({ type: "data", text: json(snapshot("en", "English")) })
    binding.setLocale("pt-BR")
    first?.emit({ type: "data", text: json(snapshot("en", "Late English")) })

    expect(first?.disposed).toBe(true)
    expect(host.watches[1]?.request).toEqual({ path: "/panel/events", query: { locale: "pt-BR" } })
    expect(binding.state()).toMatchObject({
      locale: "pt-BR",
      connection: { kind: "connecting" },
      stale: true,
    })
    expect(binding.state().snapshot?.sessions[0]?.title).toBe("English")
  })
})

describe("panel binding relay polling", () => {
  function pollingBinding() {
    const setup = liveBinding()
    setup.host.watches[0]?.emit({
      type: "connection",
      state: "unavailable",
      error: new HostRequestError("UNSUPPORTED", "relay"),
    })
    return setup
  }

  it("falls back to polling GET /panel/state when the host cannot stream", async () => {
    const { host, clock, binding } = pollingBinding()
    host.requests[0]?.respond({ status: 200, body: json(snapshot("en", "Polled")) })
    await flush()

    expect(host.requests[0]?.call).toEqual({ path: "/panel/state", method: "GET", query: { locale: "en" } })
    expect(binding.state().connection).toEqual({ kind: "polling" })
    expect(clock.pending()).toBe(1)
    expect(POLL_INTERVAL_MS).toBe(5_000)
  })

  it("polls again only after the interval elapses", async () => {
    const { host, clock } = pollingBinding()
    host.requests[0]?.respond({ status: 200, body: json(snapshot("en", "Polled")) })
    await flush()
    clock.fire()

    expect(host.requests).toHaveLength(2)
  })

  it("dispose cancels the pending timer and drops an in-flight poll", async () => {
    const { host, clock, binding } = pollingBinding()
    host.requests[0]?.respond({ status: 200, body: json(snapshot("en", "Polled")) })
    await flush()
    clock.fire()
    binding.dispose()
    host.requests[1]?.respond({ status: 200, body: json(snapshot("en", "After")) })
    await flush()

    expect(clock.pending()).toBe(0)
    expect(binding.state().snapshot?.sessions[0]?.title).toBe("Polled")
  })

  it("locale switch restarts polling in the new locale without a second timer", async () => {
    const { host, clock, binding } = pollingBinding()
    host.requests[0]?.respond({ status: 200, body: json(snapshot("en", "Polled")) })
    await flush()
    binding.setLocale("pt-BR")
    host.requests[1]?.respond({ status: 200, body: json(snapshot("pt-BR", "Português")) })
    await flush()

    expect(host.watches).toHaveLength(1)
    expect(host.requests[1]?.call.query).toEqual({ locale: "pt-BR" })
    expect(clock.pending()).toBe(1)
  })
})
