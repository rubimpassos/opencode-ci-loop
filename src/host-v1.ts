import type { Plugin } from "@opencode-ai/plugin"
import type { CiLoopHost, SessionModel } from "./host-port.ts"
import { assertNever } from "./types.ts"

export type OpencodeClient = Parameters<Plugin>[0]["client"]

export function createV1Host(client: OpencodeClient): CiLoopHost {
  return {
    sessionScope: "global",
    async getSessionTitle(sessionID, signal) {
      signal?.throwIfAborted()
      const response = await client.session.get({ path: { id: sessionID }, ...(signal && { signal }) })
      return response.data?.title
    },
    async readSessionContext(sessionID, signal) {
      signal?.throwIfAborted()
      const response = await client.session.messages({ path: { id: sessionID }, ...(signal && { signal }) })
      let model: SessionModel | undefined
      let lastUserText: string | undefined
      for (const entry of (response.data ?? []).toReversed()) {
        const info = entry.info
        switch (info.role) {
          case "assistant":
            model ??= { providerID: info.providerID, modelID: info.modelID }
            break
          case "user":
            lastUserText ??= entry.parts
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n")
            break
          default:
            assertNever(info)
        }
        if (model && lastUserText !== undefined) break
      }
      return { ...(model && { model }), lastUserText: lastUserText ?? "" }
    },
    async prompt(sessionID, content, signal) {
      if (signal?.aborted) return
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          ...(content.model && { model: content.model }),
          parts: [{ type: "text", text: content.text }],
        },
        ...(signal && { signal }),
      })
    },
    async toast(content, signal) {
      if (signal?.aborted) return
      await client.tui.showToast({ body: content, ...(signal && { signal }) })
    },
    async log(level, message) {
      try {
        await client.app.log({ body: { service: "ci-loop", level, message } })
      } catch (error) {
        // Diagnostics are best-effort: a disconnected host must never break a watch.
        if (!(error instanceof Error)) throw error
      }
    },
  }
}
