import { appendFileSync, closeSync, fstatSync, ftruncateSync, mkdirSync, openSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { CiLoopHost, SessionModel } from "./host-port.ts"
import { assertNever } from "./types.ts"

export type V2SessionApi = Pick<Plugin.Context["session"], "get" | "context" | "prompt" | "switchModel">
type HostContext = {
  readonly session: V2SessionApi
  readonly app: Pick<Plugin.Context["app"], "name">
}

export function createV2Host(
  ctx: HostContext,
  stateDirectory = join(process.env["XDG_STATE_HOME"] || join(homedir(), ".local", "state"), ctx.app.name),
): CiLoopHost {
  return {
    sessionScope: "owned",
    async getSessionTitle(sessionID, signal) {
      signal?.throwIfAborted()
      return (await ctx.session.get({ sessionID }, { ...(signal && { signal }) })).title
    },
    async readSessionContext(sessionID, signal) {
      signal?.throwIfAborted()
      const options = { ...(signal && { signal }) }
      const [messages, session] = await Promise.all([
        ctx.session.context({ sessionID }, options),
        ctx.session.get({ sessionID }, options),
      ])
      let model: SessionModel | undefined
      let lastUserText: string | undefined
      for (const message of messages.toReversed()) {
        switch (message.type) {
          case "assistant":
            model ??= { providerID: message.model.providerID, modelID: message.model.id }
            break
          case "user":
            lastUserText ??= message.text
            break
          case "agent-switched":
          case "model-switched":
          case "location-switched":
          case "synthetic":
          case "system":
          case "skill":
          case "shell":
          case "compaction":
          case "idle":
            break
          default:
            assertNever(message)
        }
        if (model && lastUserText !== undefined) break
      }
      if (!model && session.model) {
        model = { providerID: session.model.providerID, modelID: session.model.id }
      }
      return { ...(model && { model }), lastUserText: lastUserText ?? "" }
    },
    async prompt(sessionID, content, signal) {
      if (signal?.aborted) return
      const options = { ...(signal && { signal }) }
      if (content.model) {
        const current = (await ctx.session.get({ sessionID }, options)).model
        if (signal?.aborted) return
        // V2 admits prompts on the session's selected model, not a per-prompt override.
        // Leave an already-selected model (including its variant) untouched.
        if (current?.providerID !== content.model.providerID || current?.id !== content.model.modelID) {
          await ctx.session.switchModel(
            { sessionID, model: { providerID: content.model.providerID, id: content.model.modelID } },
            options,
          )
        }
      }
      if (signal?.aborted) return
      await ctx.session.prompt({ sessionID, text: content.text, delivery: "queue" }, options)
    },
    async log(level, message) {
      // No typed V2 logger exists. Synchronous append/truncation serializes local instances,
      // bounds the single file to 256 KiB, and leaves no handles/tasks to drain on unload.
      try {
        mkdirSync(stateDirectory, { recursive: true, mode: 0o700 })
        const file = openSync(join(stateDirectory, "ci-loop-v2.log"), "a", 0o600)
        try {
          const line = `${JSON.stringify({ time: new Date().toISOString(), level, message: message.slice(0, 4096) })}\n`
          if (fstatSync(file).size + Buffer.byteLength(line) > 256 * 1024) ftruncateSync(file, 0)
          appendFileSync(file, line)
        } finally {
          closeSync(file)
        }
      } catch (error) {
        // As in V1, unavailable diagnostics must not fail CI work; never write to the TUI.
        if (!(error instanceof Error)) throw error
      }
    },
  }
}
