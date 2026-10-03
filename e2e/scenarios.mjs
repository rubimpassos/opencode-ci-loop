import assert from "node:assert/strict"
import { z } from "zod"
import { firstSseFrame } from "./http.mjs"

const Session = z.object({
  sessionID: z.string(),
  enabled: z.boolean(),
  watches: z.array(z.object({}).passthrough()),
})
const Panel = z.object({
  chrome: z.object({}).passthrough(),
  sessions: z.array(
    z
      .object({
        sessionID: z.string(),
        watches: z.array(z.object({ failed: z.boolean() }).passthrough()),
      })
      .passthrough(),
  ),
})
const proxy = "/api/guests/ci-loop/loopback"

export async function S2(stack, seeded) {
  const checks = []
  // Given an installed, approved guest and actual seeded watches.
  // When the host proxies JSON with the authenticated UI cookie.
  const panel = Panel.parse(await stack.api(`${proxy}/panel/state?locale=en`))
  // Then it returns the plugin's real sessions, including failure state.
  assert(
    panel.sessions.some(
      (session) => session.sessionID === seeded.failed && session.watches.some((watch) => watch.failed),
    ),
  )
  checks.push("cookie JSON contains failed session")

  // Given a freshly minted guest-scoped GET token (no cookie).
  const token = await stack.guestToken()
  // When a real stream is read incrementally.
  const frame = Panel.parse(
    await firstSseFrame(
      `${stack.ocUrl}${proxy}/panel/events?locale=en&oc_url_token=${encodeURIComponent(token)}`,
      stack.signal,
    ),
  )
  // Then the first complete data frame contains seeded sessions.
  assert(frame.sessions.length >= 2)
  checks.push("scoped URL token receives SSE data frame")

  // Given the failing session's enabled watch.
  // When a cookie-authenticated write passes through the host.
  try {
    await stack.api(`${proxy}/sessions/${seeded.failed}/enabled`, {
      method: "POST",
      body: { enabled: false },
    })
    // Then the upstream state, not merely the proxy response, has changed.
    const disabled = Session.parse(await stack.ci(`/sessions/${seeded.failed}`))
    assert.equal(disabled.enabled, false)
    checks.push("cookie POST changes raw plugin enabled state")
  } finally {
    await stack.api(`${proxy}/sessions/${seeded.failed}/enabled`, { method: "POST", body: { enabled: true } })
  }

  // Given an installed guest whose loopback approval is revoked.
  await stack.grant([])
  try {
    // When the same authenticated reader attempts access.
    await stack.api(`${proxy}/panel/state?locale=en`, { status: 403 })
    // Then authorization refuses it, rather than serving cached state.
    checks.push("revoked approval returns 403")
  } finally {
    await stack.grant(["loopback"])
  }
  // Given the renewed grant; when reading again; then access is restored.
  Panel.parse(await stack.api(`${proxy}/panel/state?locale=en`))
  checks.push("reapproval restores 200")
  return { checks, panel, sseFrame: frame }
}

export async function S4api(stack) {
  // Given a real session without a push or a ci_watch invocation.
  const unseen = await stack.createSession("E2E unseen session")
  // When Work Status's lookup goes through the real host proxy.
  const state = Session.parse(await stack.api(`${proxy}/sessions/${unseen}`))
  // Then the configured autoWatch default is returned without a phantom watch.
  assert.equal(state.sessionID, unseen)
  assert.equal(state.enabled, true)
  assert.deepEqual(state.watches, [])
  return { checks: ["unseen session inherits configured autoWatch=true"], unseen, state }
}

export async function S6api(stack, seeded) {
  // Given a real shell push and fixture CI completion, never a harness-inserted report.
  // When the durable session messages are read through OpenCode's API.
  const messages = await stack.messages(seeded.failed)
  // Then a plugin report has an actual subsequent assistant turn and ci_watch ran.
  const reportIndex = messages.findIndex(
    (message) => message.role === "user" && message.text.startsWith("[ci-loop] "),
  )
  assert(reportIndex >= 0, "plugin report user message missing")
  assert(
    messages
      .slice(reportIndex + 1)
      .some((message) => message.role === "assistant" && message.text.length > 0),
    "assistant response after plugin report missing",
  )
  assert(
    messages.some((message) => message.tools.includes("ci_watch")),
    "ci_watch tool call part missing",
  )
  const received = stack.providerRequests().filter((request) => request.isReport)
  assert(received.length > 0, "provider never received plugin report")
  return {
    checks: [
      "durable plugin user report",
      "subsequent assistant reply",
      "ci_watch tool part",
      "provider received report",
    ],
    messages,
    sessionApi: await stack.code(`/api/session/${seeded.failed}/message?limit=100&order=asc`),
    providerReports: received,
  }
}
