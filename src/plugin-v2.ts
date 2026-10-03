import type { Plugin } from "@opencode/plugin"
import { z } from "zod"
import { SessionIdSchema } from "./host-port.ts"
import { createV2Host, type V2SessionApi } from "./host-v2.ts"
import {
  acquireShared,
  claimSession,
  handlePushResult,
  isGitPush,
  releaseShared,
  removeSession,
  updateSessionTitle,
} from "./plugin-runtime.ts"
import { assertNever, PluginConfigSchema } from "./types.ts"
import { executeWatchAction } from "./watch-tool.ts"

export type V2Context = Pick<Plugin.Context, "app" | "location" | "options" | "event"> & {
  readonly session: V2SessionApi
  readonly tool: Pick<Plugin.Context["tool"], "hook" | "transform">
}

const ShellInputSchema = z.object({
  command: z.string(),
  workdir: z.string().optional(),
  timeout: z.number().optional(),
})
const WatchInputSchema = z.strictObject({ action: z.enum(["enable", "disable", "status"]) })

/** V2 registrations are host-owned; only the event task and shared lease need explicit cleanup. */
export async function setupV2(ctx: V2Context): Promise<Plugin.Cleanup> {
  const config = PluginConfigSchema.parse(ctx.options)
  const host = createV2Host(ctx)
  const lease = acquireShared(config, host, ctx.location.directory)
  const signal = lease.registration.controller.signal
  try {
    await ctx.tool.hook("execute.after", async (event) => {
      if (signal.aborted || event.tool !== "shell") return
      switch (event.status) {
        case "error":
          return
        case "completed": {
          const input = ShellInputSchema.safeParse(event.input)
          if (!input.success || !isGitPush(input.data.command)) return
          const content = event.result.content
          const text =
            typeof content === "string"
              ? content
              : (content ?? [])
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("\n")
          const session = await ctx.session.get({ sessionID: event.sessionID }, { signal })
          const output = await handlePushResult(
            { ...lease, directory: session.location.directory },
            {
              sessionID: SessionIdSchema.parse(event.sessionID),
              command: input.data.command,
              output: text,
              args: {
                ...(input.data.workdir !== undefined && { workdir: input.data.workdir }),
              },
            },
          )
          if (output === text) return
          event.result = {
            ...event.result,
            content:
              typeof content === "string"
                ? output
                : [...(content ?? []), { type: "text", text: output.slice(text.length) }],
          }
          return
        }
        default:
          assertNever(event)
      }
    })
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "ci_watch",
        options: { codemode: false },
        description:
          "Controls the CI validation loop for this session. After git push, CI and review results are " +
          "injected automatically; do not poll manually. Use enable/disable to toggle, status to check.",
        input: z.toJSONSchema(WatchInputSchema),
        async execute(input: unknown, context) {
          const { action } = WatchInputSchema.parse(input)
          const combined = AbortSignal.any([signal, context.signal])
          combined.throwIfAborted()
          const session = await ctx.session.get({ sessionID: context.sessionID }, { signal: combined })
          combined.throwIfAborted()
          const sessionID = SessionIdSchema.parse(context.sessionID)
          claimSession(lease, sessionID)
          return {
            content: executeWatchAction(
              { ...lease, directory: session.location.directory },
              sessionID,
              action,
            ),
          }
        },
      })
    })
  } catch (error) {
    releaseShared(lease)
    throw error
  }

  const subscription = (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal })) {
        if (signal.aborted) break
        // Only title/deletion events affect watches. V2 calls title updates "session.renamed".
        // The shared runtime rejects events for sessions this instance has never claimed.
        switch (event.type) {
          case "session.renamed":
            updateSessionTitle(lease, SessionIdSchema.parse(event.data.sessionID), event.data.title)
            break
          case "session.deleted":
            removeSession(lease, SessionIdSchema.parse(event.data.sessionID))
            break
          default:
            break
        }
      }
    } catch (error) {
      // This is the event-task boundary: report failure once, without an unhandled rejection.
      if (!signal.aborted) {
        await host.log(
          "error",
          error instanceof Error ? `Session subscription failed: ${error.message}` : String(error),
        )
      }
    }
  })()
  return async () => {
    releaseShared(lease)
    await subscription
  }
}
