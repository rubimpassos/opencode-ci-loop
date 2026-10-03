import { describe, expect, it } from "bun:test"
import type { HostClient } from "@openchamber/sdk"
import type { PanelSnapshot } from "../../panel-types.ts"
import { createPanelBinding } from "../binding.ts"
import { fakeClock, fakeHost, flush, snapshot } from "../fake-host.test-support.ts"
import { createStatusController, type StatusModel } from "./status-controller.ts"

const control = (sessionID: string, enabled: boolean) => ({
  status: 200,
  body: JSON.stringify({ sessionID, enabled, watches: [], watch: null, directory: null }),
})

function setup(initial: string | null) {
  const host = fakeHost()
  const binding = createPanelBinding({ host, locale: "en", schedule: fakeClock().schedule })
  const views: StatusModel[] = []
  let notify: Parameters<HostClient["onSession"]>[0] = () => {}
  const source: Pick<HostClient, "onSession"> = {
    onSession: (listener) => {
      notify = listener
      listener(initial === null ? null : { id: initial, title: initial, busy: false })
      return () => {
        notify = () => {}
      }
    },
  }
  const controller = createStatusController(binding, source, (view) => views.push(view))
  return {
    host,
    binding,
    controller,
    view: () => views.at(-1),
    open: (id: string | null) => notify(id === null ? null : { id, title: id, busy: false }),
    push: (next: PanelSnapshot) => host.watches[0]?.emit({ type: "data", text: JSON.stringify(next) }),
  }
}

const empty = (): PanelSnapshot => ({ ...snapshot("en", "other"), sessions: [] })

describe("current-chat CI status", () => {
  it("uses the unseen chat's GET default without inventing a watch or writing a setting", async () => {
    // Given: a live snapshot has no row for this chat.
    const app = setup("ses_new")
    app.push(empty())
    // When: the real default comes back from the targeted session endpoint.
    app.host.requests[0]?.respond(control("ses_new", false))
    await flush()
    // Then: the switch reflects that default and the summary stays empty.
    expect(app.host.requests.map((entry) => entry.call)).toEqual([
      { path: "/sessions/ses_new", method: "GET" },
    ])
    expect(app.view()).toMatchObject({ sessionID: "ses_new", enabled: false, watch: null, pending: false })
  })

  it("ignores A's late GET after switching to B", async () => {
    // Given: A's GET is pending, and B has its own default.
    const app = setup("ses_a")
    app.push(empty())
    app.open("ses_b")
    app.host.requests[1]?.respond(control("ses_b", false))
    await flush()
    // When: A returns after B has been selected.
    app.host.requests[0]?.respond(control("ses_a", true))
    await flush()
    // Then: no A value is applied to B.
    expect(app.view()).toMatchObject({ sessionID: "ses_b", enabled: false, failure: null })
  })

  it("ignores A's late POST and keeps B's known switch and watch", async () => {
    // Given: A and B are in the snapshot with different switch states.
    const app = setup("ses_a")
    const first = snapshot("en", "A").sessions[0]
    if (!first) throw new Error("missing fixture session")
    app.push({
      ...empty(),
      sessions: [
        { ...first, sessionID: "ses_a" },
        { ...first, sessionID: "ses_b", enabled: true },
      ],
    })
    app.controller.toggle(false)
    expect(app.view()).toMatchObject({ sessionID: "ses_a", enabled: true, pending: true })
    // When: the user changes chats before A's write settles.
    app.open("ses_b")
    app.host.requests[0]?.respond(control("ses_a", false))
    await flush()
    // Then: B stays selected and enabled, regardless of A's result.
    expect(app.view()).toMatchObject({ sessionID: "ses_b", enabled: true, pending: false, failure: null })
    expect(app.host.requests[0]?.call).toEqual({
      path: "/sessions/ses_a/enabled",
      method: "POST",
      body: { enabled: false },
    })
  })

  it("retains the old position on a rejected POST and retries the exact change", async () => {
    // Given: a known enabled chat.
    const app = setup("ses_1")
    app.push(snapshot("en", "A"))
    // When: disabling is rejected.
    app.controller.toggle(false)
    app.host.requests[0]?.respond({ status: 400, body: "request refused" })
    await flush()
    // Then: the old checked value and a retryable inline failure survive.
    expect(app.view()).toMatchObject({
      enabled: true,
      pending: false,
      canRetry: true,
      failure: { kind: "rejected", status: 400 },
    })
    app.controller.retry()
    expect(app.view()).toMatchObject({ enabled: true, pending: true })
    app.host.requests[1]?.respond(control("ses_1", false))
    await flush()
    expect(app.view()).toMatchObject({ enabled: false, pending: false, failure: null })
  })

  it("keeps a confirmed POST over the preceding snapshot until the next SSE reconciliation", async () => {
    // Given: a snapshot still says on.
    const app = setup("ses_1")
    app.push(snapshot("en", "A"))
    // When: the POST confirms off and an unrelated connection update replays the old snapshot.
    app.controller.toggle(false)
    app.host.requests[0]?.respond(control("ses_1", false))
    await flush()
    app.host.watches[0]?.emit({ type: "connection", state: "live" })
    // Then: the confirmed value holds until a new authoritative snapshot arrives.
    expect(app.view()?.enabled).toBe(false)
    app.push(snapshot("en", "A"))
    expect(app.view()?.enabled).toBe(true)
  })

  it("shows only the open chat's newest watch and clears it on null session", () => {
    // Given: a snapshot includes other chats and two watches for the open chat.
    const app = setup("ses_1")
    const first = snapshot("en", "A").sessions[0]
    const old = first?.watches[0]
    if (!first || !old) throw new Error("missing fixture watch")
    app.push({
      ...empty(),
      sessions: [
        { ...first, watches: [old, { ...old, key: "new", phaseKey: "reviewing" }] },
        { ...first, sessionID: "ses_other", watches: [{ ...old, key: "other" }] },
      ],
    })
    // When: the current chat is deselected.
    expect(app.view()?.watch?.key).toBe("new")
    app.open(null)
    // Then: no other chat's watch or switch leaks into the empty status.
    expect(app.view()).toMatchObject({ sessionID: null, enabled: null, watch: null })
  })

  it("does not render an in-flight completion after disposal", async () => {
    // Given: a pending unseen-session GET.
    const app = setup("ses_1")
    app.push(empty())
    const before = app.view()
    // When: the section is disposed before the response arrives.
    app.controller.dispose()
    app.host.requests[0]?.respond(control("ses_1", false))
    await flush()
    // Then: the last rendered state stays untouched.
    expect(app.view()).toBe(before)
  })
})
