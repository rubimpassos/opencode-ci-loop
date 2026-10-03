import { describe, expect, it } from "bun:test"
import { z } from "zod"
import { type CiLoopHost, type HostPrompt, SessionIdSchema } from "./host-port.ts"
import type { Locale } from "./i18n.ts"
import { notifyPhase } from "./notify.ts"
import { resolveSessionContext } from "./session-context.ts"
import { type CommitSha, PluginConfigSchema, type SessionId, type Watch } from "./types.ts"

const SID = SessionIdSchema.parse("ses_port")
const SHA = z
  .custom<CommitSha>((value) => typeof value === "string" && /^[a-f0-9]+$/.test(value))
  .parse("abcdef")
const report = {
  sha: SHA,
  branch: "main",
  repo: "github.com/o/r",
  sourceKind: "session",
  directory: "/repo",
  runs: [],
  failedLogs: [],
  pr: null,
  ruleFailures: [],
  review: null,
} as const
const watch: Watch = {
  ...report,
  repoUrl: "https://github.com/o/r",
  startedAt: 0,
  phase: { kind: "done", report },
}

describe("host notification boundary", () => {
  it("injects once without a toast capability when the phase is repeated", async () => {
    // Given a port with no TUI and a model distinct from any fallback.
    const prompts: { readonly id: SessionId; readonly content: HostPrompt }[] = []
    const model = { providerID: "fixture", modelID: "selected" }
    const host: CiLoopHost = {
      sessionScope: "owned",
      getSessionTitle: async () => undefined,
      readSessionContext: async () => ({ model, lastUserText: "você pode corrigir isso por favor" }),
      prompt: async (id, content) => {
        prompts.push({ id, content })
      },
      log: async () => {},
    }
    const ctx = {
      host,
      notifications: new Set<string>(),
      locales: new Map<SessionId, Locale>(),
      config: PluginConfigSchema.parse({}),
    }
    // When the same completed watch is published twice.
    await notifyPhase(ctx, SID, watch)
    await notifyPhase(ctx, SID, watch)
    // Then only one prompt is admitted on the right session/model; locale remains domain state.
    expect(prompts.map(({ id, content }) => ({ id, model: content.model }))).toEqual([{ id: SID, model }])
    expect(ctx.locales.get(SID)).toBe("pt-BR")
  })

  it("admits no prompt when cancellation happens during the context read", async () => {
    // Given a context read held at the host boundary.
    const reading = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const prompts: HostPrompt[] = []
    const controller = new AbortController()
    const host: CiLoopHost = {
      sessionScope: "owned",
      getSessionTitle: async () => undefined,
      readSessionContext: async () => {
        reading.resolve()
        await resume.promise
        return { lastUserText: "" }
      },
      prompt: async (_id, content) => {
        prompts.push(content)
      },
      log: async () => {},
    }
    const ctx = {
      host,
      notifications: new Set<string>(),
      locales: new Map<SessionId, Locale>(),
      config: PluginConfigSchema.parse({}),
    }
    const pending = notifyPhase(ctx, SID, watch, controller.signal)
    await reading.promise
    // When the watch is cancelled before context becomes available.
    controller.abort()
    resume.resolve()
    await pending
    // Then neither a prompt nor a stale locale cache update is admitted.
    expect(prompts).toEqual([])
    expect(ctx.locales.size).toBe(0)
  })

  it("keeps a cached locale while refreshing the model when the host text changes", async () => {
    // Given existing language detection and a new host-selected model.
    const locales = new Map<SessionId, Locale>([[SID, "pt-BR"]])
    const model = { providerID: "new-provider", modelID: "new-model" }
    const host: CiLoopHost = {
      sessionScope: "global",
      getSessionTitle: async () => undefined,
      readSessionContext: async () => ({ model, lastUserText: "please fix this" }),
      prompt: async () => {},
      log: async () => {},
    }
    // When another report resolves its context.
    const context = await resolveSessionContext({ host, config: PluginConfigSchema.parse({}), locales }, SID)
    // Then cached language wins but the model is fresh.
    expect(context).toEqual({ model, locale: "pt-BR" })
  })
})
