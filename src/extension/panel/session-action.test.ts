import { describe, expect, it } from "bun:test"
import { flush, snapshot } from "../fake-host.test-support.ts"
import { panelHarness } from "./panel-harness.test-support.ts"

describe("rail session actions", () => {
  it("keeps the switch authoritative while pending, shows a local failure and retries", async () => {
    // Given: a live, enabled watch with no request in flight.
    const app = panelHarness()
    try {
      app.push(snapshot("en", "Fix CI"))
      const control = app.root.querySelector<HTMLButtonElement>('[role="switch"]')
      if (!control) throw new Error("switch missing")
      expect(control.getAttribute("aria-checked")).toBe("true")

      // When: the user disables it, the host rejects the write, then retry succeeds.
      control.click()
      expect(control.disabled).toBe(true)
      expect(control.getAttribute("aria-checked")).toBe("true")
      expect(app.fake.requests[0]?.call).toEqual({
        path: "/sessions/ses_1/enabled",
        method: "POST",
        body: { enabled: false },
      })
      app.fake.requests[0]?.respond({ status: 503, body: "offline" })
      await flush()
      // The stub intentionally supports simple selectors only; use the mounted retry root.
      const retryRoot = app.root.querySelector<HTMLElement>(".ci-retry")
      const retryButton = retryRoot?.querySelector<HTMLButtonElement>("button")
      expect(app.root.querySelector<HTMLElement>(".ci-session-error")?.hidden).toBe(false)
      expect(retryRoot?.hidden).toBe(false)
      expect(control.getAttribute("aria-checked")).toBe("true")
      retryButton?.click()
      expect(app.fake.requests[1]?.call.body).toEqual({ enabled: false })
      app.fake.requests[1]?.respond({
        status: 200,
        body: JSON.stringify({ sessionID: "ses_1", enabled: false }),
      })
      await flush()

      // Then: no optimistic flip occurred; success and the following SSE frame agree.
      expect(control.getAttribute("aria-checked")).toBe("false")
      expect(control.disabled).toBe(false)
      expect(app.root.querySelector<HTMLElement>(".ci-session-error")?.hidden).toBe(true)
      const current = snapshot("en", "Fix CI")
      const session = current.sessions[0]
      if (!session) throw new Error("session fixture missing")
      app.push({ ...current, sessions: [{ ...session, enabled: false }] })
      expect(control.getAttribute("aria-checked")).toBe("false")
    } finally {
      app.close()
    }
  })

  it("refuses a stale toggle and keeps its original state until connection returns", () => {
    // Given: an enabled watch is visible, then the stream becomes unavailable.
    const app = panelHarness()
    try {
      app.push(snapshot("en", "Fix CI"))
      app.fake.watches[0]?.emit({ type: "connection", state: "connecting" })
      const control = app.root.querySelector<HTMLButtonElement>('[role="switch"]')

      // When: the user tries to click a switch while its last snapshot is stale.
      control?.click()

      // Then: the control is disabled, the old value remains visible, and no POST was issued.
      expect(control?.disabled).toBe(true)
      expect(control?.getAttribute("aria-checked")).toBe("true")
      expect(app.fake.requests).toHaveLength(0)
    } finally {
      app.close()
    }
  })

  it("keeps the confirmed toggle across local filter renders before another server frame arrives", async () => {
    // Given: a successful write has returned but the last SSE frame still says enabled.
    const app = panelHarness()
    try {
      const frame = snapshot("en", "Fix CI")
      const phase = frame.sessions[0]?.watches[0]?.phaseKey
      if (!phase) throw new Error("fixture has no phase")
      app.push(frame)
      const control = app.root.querySelector<HTMLButtonElement>('[role="switch"]')
      control?.click()
      app.fake.requests[0]?.respond({
        status: 200,
        body: JSON.stringify({ sessionID: "ses_1", enabled: false }),
      })
      await flush()
      expect(control?.getAttribute("aria-checked")).toBe("false")

      // When: the user changes a phase chip before the next SSE frame.
      const chip = [...app.root.querySelectorAll<HTMLButtonElement>(".ci-chip")].find(
        (button) => button.textContent === frame.chrome.phaseChips[phase],
      )
      chip?.click()

      // Then: a local rerender cannot restore the stale value from the previous frame.
      expect(control?.getAttribute("aria-checked")).toBe("false")
    } finally {
      app.close()
    }
  })
})
