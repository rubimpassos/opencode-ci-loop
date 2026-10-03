import { type Plugin, tool } from "@opencode-ai/plugin"
import { SessionIdSchema } from "./host-port.ts"
import { createV1Host } from "./host-v1.ts"
import {
  acquireShared,
  claimSession,
  handlePushResult,
  releaseShared,
  removeSession,
  updateSessionTitle,
} from "./plugin-runtime.ts"
import { PluginConfigSchema } from "./types.ts"
import { executeWatchAction } from "./watch-tool.ts"

const BashArgsSchema = tool.schema.object({ command: tool.schema.string() }).loose()
// Match the resolver's whole-object fallback for malformed optional directory fields.
const DirectoryArgsSchema = tool.schema
  .object({
    workdir: tool.schema.string().optional(),
    cwd: tool.schema.string().optional(),
  })
  .catch({})

export const CiLoopPlugin: Plugin = async ({ client, directory }, options) => {
  const config = PluginConfigSchema.parse(options ?? {})
  const lease = acquireShared(config, createV1Host(client), directory)
  return {
    "tool.execute.after": async (input, output) => {
      if (input.tool !== "bash") return
      const args = BashArgsSchema.safeParse(input.args)
      if (!args.success) return
      const directoryArgs = DirectoryArgsSchema.parse(input.args)
      output.output = await handlePushResult(lease, {
        sessionID: SessionIdSchema.parse(input.sessionID),
        command: args.data.command,
        output: output.output,
        args: {
          ...(directoryArgs.workdir !== undefined && { workdir: directoryArgs.workdir }),
          ...(directoryArgs.cwd !== undefined && { cwd: directoryArgs.cwd }),
        },
      })
    },
    event: async ({ event }) => {
      // All other public V1 event variants are intentionally irrelevant to CI watches.
      switch (event.type) {
        case "session.updated":
          updateSessionTitle(
            lease,
            SessionIdSchema.parse(event.properties.info.id),
            event.properties.info.title,
          )
          break
        case "session.deleted":
          removeSession(lease, SessionIdSchema.parse(event.properties.info.id))
          break
        default:
          break
      }
    },
    tool: {
      ci_watch: tool({
        description:
          "Controls the CI validation loop for this session. After a `git push`, the loop watches GitHub " +
          "Actions and injects the result (including failure logs) into the session automatically — you NEVER " +
          "need to wait for or manually poll CI (no `sleep`, `gh pr checks`, `gh run watch`). " +
          "Use action=enable/disable to toggle it for this session, action=status to check.",
        args: { action: tool.schema.enum(["enable", "disable", "status"]) },
        async execute(args, context) {
          const sessionID = SessionIdSchema.parse(context.sessionID)
          claimSession(lease, sessionID)
          return executeWatchAction(lease, sessionID, args.action)
        },
      }),
    },
    dispose: async () => releaseShared(lease),
  }
}
