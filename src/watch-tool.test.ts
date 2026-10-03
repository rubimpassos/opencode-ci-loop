import { describe, expect, it } from "bun:test"
import { z } from "zod"
import { SessionIdSchema } from "./host-port.ts"
import { type CiGh, WatchRegistry } from "./registry.ts"
import { type CommitSha, PluginConfigSchema, type PushTarget } from "./types.ts"
import { executeWatchAction } from "./watch-tool.ts"

const SID = SessionIdSchema.parse("ses_action")
const target: PushTarget = {
  sha: z.custom<CommitSha>((value) => typeof value === "string" && /^[a-f0-9]+$/.test(value)).parse("abcdef"),
  branch: "main",
  repo: "github.com/o/r",
  repoUrl: "https://github.com/o/r",
  directory: "/repo",
  sourceKind: "session",
}
const gh: CiGh = {
  listRuns: async () => [],
  buildReport: async () => ({
    ...target,
    runs: [],
    failedLogs: [],
    pr: null,
    ruleFailures: [],
    review: null,
  }),
  findPrForBranch: async () => null,
  reviewSnapshot: async () => ({
    prNumber: 1,
    prState: "OPEN",
    merged: false,
    reviewDecision: null,
    mergeStateStatus: "CLEAN",
    threads: [],
    reviews: [],
    comments: [],
    fetchedAt: 0,
  }),
}

describe("executeWatchAction", () => {
  it.each(["enable", "disable"] as const)("changes the session setting when action is %s", (action) => {
    // Given the opposite configured default.
    const registry = new WatchRegistry(PluginConfigSchema.parse({ autoWatch: action === "disable" }), {
      onChange: () => {},
      onPhase: async () => {},
      onReviewUpdate: async () => {},
    })
    try {
      // When the pure tool core executes without a host SDK.
      executeWatchAction({ registry, directory: "/repo", dashboardUrl: "http://fixture" }, SID, action)
      // Then only the supplied session setting is changed.
      expect(registry.sessionView(SID).enabled).toBe(action === "enable")
      expect(registry.sessionView(SID).directory).toBe("/repo")
    } finally {
      registry.dispose()
    }
  })

  it("cancels the active watch when disabled", async () => {
    // Given a real registry parked at its cancellable sleep boundary.
    const entered = Promise.withResolvers<AbortSignal>()
    const registry = new WatchRegistry(
      PluginConfigSchema.parse({ review: { enabled: false } }),
      {
        onChange: () => {},
        onPhase: async () => {},
        onReviewUpdate: async () => {},
      },
      async (_ms, signal) => {
        entered.resolve(signal)
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        )
      },
    )
    const running = registry.startWatch(SID, target, gh)
    const signal = await entered.promise
    try {
      // When the tool disables the watch.
      executeWatchAction({ registry, directory: "/repo", dashboardUrl: "http://fixture" }, SID, "disable")
      await running
      // Then the generation is aborted and no watch remains.
      expect(signal.aborted).toBe(true)
      expect(registry.sessionView(SID).watches).toEqual([])
    } finally {
      registry.dispose()
    }
  })

  it("leaves an existing setting unchanged when status is requested", () => {
    // Given a disabled session.
    const registry = new WatchRegistry(PluginConfigSchema.parse({}), {
      onChange: () => {},
      onPhase: async () => {},
      onReviewUpdate: async () => {},
    })
    registry.setEnabled(SID, false, "/repo")
    const before = registry.sessionView(SID)
    try {
      // When querying status.
      executeWatchAction({ registry, directory: "/repo", dashboardUrl: "http://fixture" }, SID, "status")
      // Then status does not toggle or replace watches.
      expect(registry.sessionView(SID)).toEqual(before)
    } finally {
      registry.dispose()
    }
  })
})
