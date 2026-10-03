import { expect, it } from "bun:test"
import { statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { SessionIdSchema } from "./host-port.ts"
import { createV2Host } from "./host-v2.ts"
import { resolveSessionContext } from "./session-context.ts"
import { PluginConfigSchema } from "./types.ts"
import { SessionFake, SID, v2Fixture } from "./v2-fixture.test.ts"

const sessionID = SessionIdSchema.parse(SID)
const app = { name: "opencode" }

it("selects the last assistant model and user locale when later messages are synthetic", async () => {
  // Given mixed V2 context with distinct historical, selected and most-recent assistant models.
  const session = new SessionFake("/fixture")
  const base = { id: "msg_fixture", time: { created: 0 } }
  session.messages = [
    { ...base, type: "user", text: "please fix this" },
    { ...base, type: "assistant", agent: "build", model: { providerID: "old", id: "old" }, content: [] },
    {
      ...base,
      type: "assistant",
      agent: "build",
      model: { providerID: "latest", id: "chosen" },
      content: [],
    },
    { ...base, type: "user", text: "você pode corrigir isso por favor" },
    { ...base, type: "synthetic", text: "please use English" },
  ]
  const host = createV2Host({ app, session: session.api })
  // When the shared notification context resolves through the adapter.
  const context = await resolveSessionContext(
    {
      host,
      config: PluginConfigSchema.parse({}),
      locales: new Map(),
    },
    sessionID,
  )
  // Then model/locale routing uses the last assistant and real user, not the later synthetic input.
  expect(context).toEqual({ model: { providerID: "latest", modelID: "chosen" }, locale: "pt-BR" })
})

it("reads the title when the V2 session has been renamed", async () => {
  // Given a session whose title differs from the fixture default.
  const session = new SessionFake("/fixture")
  session.info = { ...session.info, title: "renamed" }
  const host = createV2Host({ app, session: session.api })
  // When its title is requested.
  const title = await host.getSessionTitle(sessionID)
  // Then the session metadata supplies the title.
  expect(title).toBe("renamed")
})

it("falls back to the selected model when the context has no assistant", async () => {
  // Given an empty context and a selected session model.
  const session = new SessionFake("/fixture")
  const host = createV2Host({ app, session: session.api })
  // When the adapter reads context.
  const context = await host.readSessionContext(sessionID)
  // Then the metadata supplies the model without inventing user text.
  expect(context).toEqual({ model: { providerID: "fallback", modelID: "default" }, lastUserText: "" })
})

it("queues the report on its requested model when selection differs", async () => {
  // Given a requested model distinct from the selected fallback.
  const session = new SessionFake("/fixture")
  const host = createV2Host({ app, session: session.api })
  const signal = new AbortController().signal
  // When a report is admitted.
  await host.prompt(sessionID, { model: { providerID: "chosen", modelID: "model" }, text: "payload" }, signal)
  // Then one durable user prompt queues on the chosen model, with cancellation propagated.
  expect(session.prompts).toEqual([
    {
      input: { sessionID: SID, text: "payload", delivery: "queue" },
      model: { providerID: "chosen", id: "model" },
    },
  ])
  expect(session.signals.every((seen) => seen === signal)).toBe(true)
})

it("preserves the variant when the requested model is already selected", async () => {
  // Given a selected variant on the same provider/model.
  const session = new SessionFake("/fixture")
  const host = createV2Host({ app, session: session.api })
  // When the report requests that model without specifying a variant.
  await host.prompt(sessionID, {
    model: { providerID: "fallback", modelID: "default" },
    text: "payload",
  })
  // Then admission preserves the user's variant.
  expect(session.prompts[0]?.model).toEqual({ providerID: "fallback", id: "default", variant: "high" })
  expect(session.switches).toEqual([])
})

it("admits nothing when cancellation arrives during model selection", async () => {
  // Given a session read held at the API boundary.
  const session = new SessionFake("/fixture")
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const controller = new AbortController()
  const host = createV2Host({
    app,
    session: {
      ...session.api,
      get: async () => {
        entered.resolve()
        await resume.promise
        return session.info
      },
    },
  })
  const pending = host.prompt(
    sessionID,
    {
      model: { providerID: "chosen", modelID: "model" },
      text: "payload",
    },
    controller.signal,
  )
  await entered.promise
  // When the watch is cancelled while awaiting the host.
  controller.abort()
  resume.resolve()
  await pending
  // Then neither model selection nor prompt admission takes place.
  expect(session.switches).toEqual([])
  expect(session.prompts).toEqual([])
})

it("admits nothing when a report is already cancelled", async () => {
  // Given an aborted watch signal.
  const session = new SessionFake("/fixture")
  const host = createV2Host({ app, session: session.api })
  // When notification reaches the adapter.
  await host.prompt(sessionID, { text: "payload" }, AbortSignal.abort())
  // Then no request reaches the session API.
  expect(session.signals).toEqual([])
  expect(session.prompts).toEqual([])
})

it("bounds diagnostics when the previous log fills its budget", async () => {
  // Given a full diagnostic file in owned scratch.
  using fixture = v2Fixture()
  const file = join(fixture.directory, "ci-loop-v2.log")
  writeFileSync(file, "x".repeat(256 * 1024), { mode: 0o600 })
  const host = createV2Host(fixture.ctx, fixture.directory)
  // When an operator diagnostic is emitted.
  await host.log("error", "fixture failure")
  // Then rotation retains a structured record within the budget and with private permissions.
  expect(await Bun.file(file).json()).toMatchObject({ level: "error", message: "fixture failure" })
  expect(statSync(file).size).toBeLessThan(256 * 1024)
  expect(statSync(file).mode & 0o777).toBe(0o600)
})
