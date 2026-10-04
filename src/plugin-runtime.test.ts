import { describe, expect, it } from "bun:test"
import { z } from "zod"
import { type CiLoopHost, type HostPrompt, SessionIdSchema } from "./host-port.ts"
import {
  acquireShared,
  claimSession,
  handlePushResult,
  isGitPush,
  releaseShared,
  removeSession,
  updateSessionTitle,
} from "./plugin-runtime.ts"
import type { CiGh } from "./registry.ts"
import { type CommitSha, PluginConfigSchema, type PushTarget, type SessionId } from "./types.ts"

const SID = SessionIdSchema.parse("ses_runtime")
const target: PushTarget = {
  sha: z.custom<CommitSha>((value) => typeof value === "string" && /^[a-f0-9]+$/.test(value)).parse("abcdef"),
  branch: "main",
  repo: "github.com/o/r",
  repoUrl: "https://github.com/o/r",
  directory: "/repo",
  sourceKind: "session",
}
const gh: CiGh = {
  listRuns: async () => [
    {
      id: 1,
      name: "ci",
      workflowName: "ci",
      status: "completed",
      conclusion: "success",
      url: "https://example.com",
      branch: "main",
    },
  ],
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

function config() {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = reservation.port
  reservation.stop(true)
  return PluginConfigSchema.parse({
    dashboard: { enabled: true, port },
    initialDelayMs: 0,
    review: { enabled: false },
  })
}

function recordingHost(scope: CiLoopHost["sessionScope"] = "global") {
  const prompts: {
    readonly sessionID: SessionId
    readonly content: HostPrompt
    readonly signal?: AbortSignal
  }[] = []
  const prompted = Promise.withResolvers<void>()
  const cancelled = Promise.withResolvers<void>()
  const host: CiLoopHost = {
    sessionScope: scope,
    getSessionTitle: async () => "fixture-title",
    readSessionContext: async () => ({ lastUserText: "" }),
    prompt: async (sessionID, content, signal) => {
      prompts.push({ sessionID, content, ...(signal && { signal }) })
      signal?.addEventListener("abort", () => cancelled.resolve(), { once: true })
      prompted.resolve()
    },
    log: async () => {},
  }
  return { host, prompts, prompted: prompted.promise, cancelled: cancelled.promise }
}

describe("shared runtime lifecycle", () => {
  it("keeps one server alive until the last lease is released when two instances share a port", async () => {
    // Given two live instances on the same dashboard port.
    const settings = config()
    const host = recordingHost().host
    const a = acquireShared(settings, host, "/a")
    const b = acquireShared(settings, host, "/b")
    try {
      expect(a.shared).toBe(b.shared)
      expect(a.shared.refs).toBe(2)
      // When one instance is released, including a repeated disposal.
      releaseShared(a)
      releaseShared(a)
      // Then the other instance still serves real HTTP and owns one reference.
      expect(b.shared.refs).toBe(1)
      expect((await fetch(`${b.dashboardUrl}/state`)).status).toBe(200)
    } finally {
      releaseShared(a)
      releaseShared(b)
    }
    // Last release frees the actual listen socket, not merely a counter.
    const replacement = Bun.serve({
      hostname: "127.0.0.1",
      port: settings.dashboard.port,
      fetch: () => new Response(),
    })
    replacement.stop(true)
  })

  it("selects the newest live global adapter when an older instance owns the session", async () => {
    // Given V1's globally addressable sessions and two adapters.
    const settings = config()
    const first = recordingHost()
    const latest = recordingHost()
    const a = acquireShared(settings, first.host)
    const b = acquireShared(settings, latest.host)
    claimSession(a, SID)
    try {
      // When a real registry watch completes.
      await a.registry.startWatch(SID, target, gh)
      await latest.prompted
      // Then the latest V1 adapter receives the report.
      expect(latest.prompts.map((prompt) => prompt.sessionID)).toEqual([SID])
      expect(first.prompts).toEqual([])
    } finally {
      releaseShared(a)
      releaseShared(b)
    }
  })

  it("falls back to the remaining adapter when the newest adapter is disposed", async () => {
    // Given a newer adapter that no longer exists.
    const settings = config()
    const first = recordingHost()
    const latest = recordingHost()
    const a = acquireShared(settings, first.host)
    const b = acquireShared(settings, latest.host)
    claimSession(a, SID)
    releaseShared(b)
    try {
      // When the surviving registry produces a notification.
      await a.registry.startWatch(SID, target, gh)
      await first.prompted
      // Then no prompt reaches the disposed host.
      expect(first.prompts.map((prompt) => prompt.sessionID)).toEqual([SID])
      expect(latest.prompts).toEqual([])
    } finally {
      releaseShared(a)
      releaseShared(b)
    }
  })

  it.each(["owned", "global"] as const)(
    "routes to the owning adapter when a newer %s host exists",
    async (scope) => {
      // Given two instance-scoped hosts.
      const settings = config()
      const first = recordingHost("owned")
      const latest = recordingHost(scope)
      const a = acquireShared(settings, first.host)
      const b = acquireShared(settings, latest.host)
      claimSession(a, SID)
      try {
        // When the older owner's watch completes.
        await a.registry.startWatch(SID, target, gh)
        await first.prompted
        // Then the report stays in its owning host scope.
        expect(first.prompts.map((prompt) => prompt.sessionID)).toEqual([SID])
        expect(latest.prompts).toEqual([])
      } finally {
        releaseShared(a)
        releaseShared(b)
      }
    },
  )

  it("cancels admitted host work when its instance is disposed while another remains", async () => {
    // Given an admitted prompt on the latest adapter.
    const settings = config()
    const first = recordingHost()
    const latest = recordingHost()
    const a = acquireShared(settings, first.host)
    const b = acquireShared(settings, latest.host)
    claimSession(a, SID)
    await a.registry.startWatch(SID, target, gh)
    await latest.prompted
    try {
      // When that adapter is released.
      releaseShared(b)
      await latest.cancelled
      // Then its work is cancelled without destroying the shared watch or server.
      expect(latest.prompts[0]?.signal?.aborted).toBe(true)
      expect(a.registry.sessionView(SID).watch?.phase.kind).toBe("done")
      expect(a.shared.refs).toBe(1)
    } finally {
      releaseShared(a)
      releaseShared(b)
    }
  })

  it("ignores foreign session events when a scoped adapter does not own the session", () => {
    // Given an owner with cached title, locale and dedup state.
    const settings = config()
    const a = acquireShared(settings, recordingHost("owned").host)
    const b = acquireShared(settings, recordingHost("owned").host)
    claimSession(a, SID)
    updateSessionTitle(a, SID, "owner-title")
    a.shared.locales.set(SID, "pt-BR")
    a.shared.notifications.add(`${SID}\0fingerprint`)
    try {
      // When a different scoped adapter receives foreign update/delete events.
      updateSessionTitle(b, SID, "foreign-title")
      removeSession(b, SID)
      // Then the owner's data is untouched.
      expect(a.shared.titles.get(SID)).toBe("owner-title")
      expect(a.shared.locales.get(SID)).toBe("pt-BR")
      expect(a.shared.notifications.size).toBe(1)
    } finally {
      releaseShared(a)
      releaseShared(b)
    }
  })

  it.each(["! [rejected]", "fatal:", "error: failed to push"])(
    "rejects push output containing %s before creating session state",
    async (output) => {
      // Given a successful-tool result containing Git's failure marker.
      const lease = acquireShared(config(), recordingHost().host)
      try {
        // When the host-independent push flow handles it.
        const result = await handlePushResult(lease, {
          sessionID: SID,
          command: "git push",
          output,
          args: {},
        })
        // Then the output and registry remain unchanged.
        expect(result).toBe(output)
        expect(lease.registry.snapshot()).toEqual([])
      } finally {
        releaseShared(lease)
      }
    },
  )

  it("removes scoped watches when their last owning instance is released", async () => {
    // Given a completed watch whose owner cannot be replaced by the other scoped instance.
    const settings = config()
    const owner = recordingHost("owned")
    const a = acquireShared(settings, owner.host)
    const b = acquireShared(settings, recordingHost("owned").host)
    claimSession(a, SID)
    await a.registry.startWatch(SID, target, gh)
    await owner.prompted
    try {
      // When the owner unloads.
      releaseShared(a)
      // Then scoped work is cancelled without tearing down the other instance.
      expect(b.registry.snapshot()).toEqual([])
      expect(b.shared.notifications.size).toBe(0)
      expect(b.shared.refs).toBe(1)
    } finally {
      releaseShared(a)
      releaseShared(b)
    }
  })
})

describe("isGitPush", () => {
  it.each([
    ["git push", true],
    ["git push origin main", true],
    ["git push --force-with-lease origin feat/x", true],
    ["cd backend && git push", true],
    ["git -C /repo push origin main", true],
    ["git add . && git commit -m 'x' && git push", true],
    ["git push --dry-run", false],
    ["git pull origin main", false],
    ["echo push", false],
    ["git status", false],
  ])("classifies %j as push=%p", (command, expected) => {
    expect(isGitPush(command)).toBe(expected)
  })
})
