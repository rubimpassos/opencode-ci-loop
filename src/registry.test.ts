import { describe, expect, it } from "bun:test"
import { GhError } from "./gh.ts"
import { type CiGh, WatchRegistry, watchKey } from "./registry.ts"
import {
  type CiReport,
  type CommitSha,
  type MidCiReviewUpdate,
  PluginConfigSchema,
  type PrInfo,
  type PushTarget,
  type ReviewComment,
  type ReviewSnapshot,
  type ReviewThread,
  type SessionId,
  type Watch,
  type WatchPhase,
  type WorkflowRun,
} from "./types.ts"

const SESSION = "ses_test" as SessionId
const SHA = "abc123" as CommitSha

function target(branch = "main", sha = SHA): PushTarget {
  return {
    sha,
    branch,
    repo: "github.com/o/r",
    repoUrl: "https://github.com/o/r",
    directory: "/repo",
    sourceKind: "session",
  }
}

function makeRun(status: WorkflowRun["status"], conclusion: WorkflowRun["conclusion"]): WorkflowRun {
  return {
    id: 1,
    name: "ci",
    workflowName: "CI",
    status,
    conclusion,
    url: "https://example.com",
    branch: "main",
  }
}

function prInfo(number = 7): PrInfo {
  return {
    number,
    title: "feat: x",
    url: "https://example.com/pr/7",
    isDraft: false,
    state: "OPEN",
    mergeable: "MERGEABLE",
    mergeStateStatus: "UNSTABLE",
    reviewDecision: null,
    commitCount: 1,
    checks: [],
  }
}

function comment(databaseId: number, author = "Copilot"): ReviewComment {
  return {
    databaseId,
    author,
    body: "please fix this",
    path: "src/a.ts",
    line: 3,
    url: `https://example.com/c/${databaseId}`,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  }
}

function thread(id: string, isResolved: boolean, comments: readonly ReviewComment[]): ReviewThread {
  return { id, isResolved, isOutdated: false, comments }
}

function snap(overrides: Partial<ReviewSnapshot> = {}): ReviewSnapshot {
  return {
    prNumber: 7,
    prState: "OPEN",
    merged: false,
    reviewDecision: null,
    mergeStateStatus: "UNSTABLE",
    threads: [],
    reviews: [],
    comments: [],
    fetchedAt: 0,
    ...overrides,
  }
}

function makeReport(pushTarget: PushTarget, pr: PrInfo | null, runs: readonly WorkflowRun[]): CiReport {
  return {
    sha: pushTarget.sha,
    branch: pushTarget.branch,
    repo: pushTarget.repo,
    sourceKind: pushTarget.sourceKind,
    directory: pushTarget.directory,
    runs,
    failedLogs: [],
    pr,
    ruleFailures: [],
    review: null,
  }
}

/** Fake CiGh: each listRuns call consumes the next scripted response. */
function fakeGh(script: readonly (readonly WorkflowRun[])[]): CiGh {
  let call = 0
  return {
    listRuns: async () => script[Math.min(call++, script.length - 1)] ?? [],
    buildReport: async (pushTarget) => makeReport(pushTarget, null, script[script.length - 1] ?? []),
    findPrForBranch: async () => null,
    reviewSnapshot: async () => {
      throw new Error("reviewSnapshot must not be called without a PR")
    },
  }
}

type SnapshotStep = ReviewSnapshot | "gh-error"

/** Review-capable fake: scripted runs + scripted snapshots ("gh-error" throws GhError); last entries repeat. */
function reviewGh(options: {
  readonly runs: readonly (readonly WorkflowRun[])[]
  readonly pr: PrInfo | null | "gh-error"
  readonly snapshots: readonly SnapshotStep[]
}): { readonly gh: CiGh; readonly snapshotCalls: () => number } {
  let runCall = 0
  let snapCall = 0
  const reportPr = options.pr === "gh-error" || options.pr === null ? null : options.pr
  const gh: CiGh = {
    listRuns: async () => options.runs[Math.min(runCall++, options.runs.length - 1)] ?? [],
    buildReport: async (pushTarget) =>
      makeReport(pushTarget, reportPr, options.runs[options.runs.length - 1] ?? []),
    findPrForBranch: async () => {
      if (options.pr === "gh-error") throw new GhError(["gh", "pr", "view"], 1, "boom")
      return options.pr
    },
    reviewSnapshot: async () => {
      const step = options.snapshots[Math.min(snapCall++, options.snapshots.length - 1)]
      if (step === undefined || step === "gh-error") throw new GhError(["gh", "api", "graphql"], 1, "boom")
      return step
    },
  }
  return { gh, snapshotCalls: () => snapCall }
}

function testConfig(overrides: Record<string, unknown> = {}) {
  return PluginConfigSchema.parse({
    pollIntervalMs: 1000,
    initialDelayMs: 0,
    dashboard: { enabled: false },
    ...overrides,
  })
}

const instantSleep = async (): Promise<void> => {}

function scriptedNow(values: readonly number[]): () => number {
  let call = 0
  return () => values[Math.min(call++, values.length - 1)] ?? 0
}

type CollectedUpdate = { readonly phaseKind: WatchPhase["kind"]; readonly update: MidCiReviewUpdate }

function collectPhases(): {
  phases: string[]
  watches: Watch[]
  updates: CollectedUpdate[]
  events: ConstructorParameters<typeof WatchRegistry>[1]
} {
  const phases: string[] = []
  const watches: Watch[] = []
  const updates: CollectedUpdate[] = []
  return {
    phases,
    watches,
    updates,
    events: {
      onChange: () => {},
      onPhase: async (_session: SessionId, watch: Watch) => {
        phases.push(watch.phase.kind)
        watches.push(watch)
      },
      onReviewUpdate: async (_session: SessionId, watch: Watch, update: MidCiReviewUpdate) => {
        updates.push({ phaseKind: watch.phase.kind, update })
      },
    },
  }
}

function phaseOf<K extends WatchPhase["kind"]>(
  watches: readonly Watch[],
  kind: K,
): Extract<WatchPhase, { readonly kind: K }> {
  const found = watches
    .map((watch) => watch.phase)
    .find((phase): phase is Extract<WatchPhase, { readonly kind: K }> => phase.kind === kind)
  if (found === undefined) throw new Error(`no ${kind} phase emitted`)
  return found
}

describe("WatchRegistry", () => {
  it("transitions waiting -> running -> done when runs complete", async () => {
    const gh = fakeGh([[], [makeRun("in_progress", null)], [makeRun("completed", "success")]])
    const { phases, events } = collectPhases()
    const registry = new WatchRegistry(testConfig(), events, instantSleep)

    await registry.startWatch(SESSION, target(), gh)

    expect(phases).toEqual(["waiting", "running", "done"])
    const state = registry.snapshot().find((s) => s.sessionID === SESSION)
    expect(state?.watches[0]?.phase.kind).toBe("done")
    expect(state?.watch).toEqual(state?.watches[0])
  })

  it("respects autoWatch default and per-session disable", () => {
    const { events } = collectPhases()
    const registry = new WatchRegistry(testConfig(), events, instantSleep)

    expect(registry.isEnabled(SESSION)).toBe(true)
    registry.setEnabled(SESSION, false)
    expect(registry.isEnabled(SESSION)).toBe(false)
  })

  it("sessionView returns autoWatch default without creating the session", () => {
    const changes: number[] = []
    const registry = new WatchRegistry(testConfig(), {
      onChange: (sessions) => changes.push(sessions.length),
      onPhase: async () => {},
      onReviewUpdate: async () => {},
    })

    const view = registry.sessionView(SESSION)
    expect(view).toEqual({ sessionID: SESSION, enabled: true, watches: [], watch: null, directory: null })
    expect(registry.snapshot()).toHaveLength(0)
    expect(changes).toHaveLength(0)
  })

  it("captures directory from instance-scoped calls without clobbering it on later directory-less calls", () => {
    const { events } = collectPhases()
    const registry = new WatchRegistry(testConfig(), events, instantSleep)

    registry.setEnabled(SESSION, true)
    expect(registry.sessionView(SESSION).directory).toBeNull()

    expect(registry.isEnabled(SESSION, "/home/user/projects/openchamber")).toBe(true)
    registry.setEnabled(SESSION, false)

    expect(registry.sessionView(SESSION).directory).toBe("/home/user/projects/openchamber")
    expect(registry.snapshot()).toEqual([
      {
        sessionID: SESSION,
        enabled: false,
        watches: [],
        watch: null,
        directory: "/home/user/projects/openchamber",
      },
    ])
  })

  it("sessionView reflects a persisted per-session toggle", () => {
    const { events } = collectPhases()
    const registry = new WatchRegistry(testConfig(), events, instantSleep)

    registry.setEnabled(SESSION, false)
    expect(registry.sessionView(SESSION).enabled).toBe(false)
  })

  it("disabling a session aborts its active watch", async () => {
    const runningForever = fakeGh([[makeRun("in_progress", null)]])
    const { phases, events } = collectPhases()
    const registry = new WatchRegistry(testConfig(), events, instantSleep)

    const watchPromise = registry.startWatch(SESSION, target(), runningForever)
    registry.setEnabled(SESSION, false)
    await watchPromise

    expect(phases).not.toContain("done")
    expect(phases).not.toContain("timed-out")
    expect(registry.sessionView(SESSION).watches).toEqual([])
  })

  it("reports error phase when gh fails", async () => {
    const broken: CiGh = {
      listRuns: async () => {
        throw new Error("gh not authenticated")
      },
      buildReport: async () => {
        throw new Error("unreachable")
      },
      findPrForBranch: async () => null,
      reviewSnapshot: async () => {
        throw new Error("unreachable")
      },
    }
    const { phases, events } = collectPhases()
    const registry = new WatchRegistry(testConfig(), events, instantSleep)

    await registry.startWatch(SESSION, target(), broken)

    expect(phases).toEqual(["waiting", "error"])
  })

  it("keeps independent watches for different destination branches", async () => {
    const { events } = collectPhases()
    const registry = new WatchRegistry(testConfig(), events, instantSleep)

    await Promise.all([
      registry.startWatch(SESSION, target("feature/a"), fakeGh([[makeRun("completed", "success")]])),
      registry.startWatch(
        SESSION,
        target("feature/b", "def456" as CommitSha),
        fakeGh([[makeRun("completed", "success")]]),
      ),
    ])

    const state = registry.sessionView(SESSION)
    expect(state.watches.map((watch) => watch.branch)).toEqual(["feature/a", "feature/b"])
    expect(state.watch?.branch).toBe("feature/b")
  })

  it("supersedes the same repo branch and blocks stale phase emissions", async () => {
    const oldResult = Promise.withResolvers<readonly WorkflowRun[]>()
    const entered = Promise.withResolvers<void>()
    const emitted: Array<{ readonly sha: CommitSha; readonly phase: string }> = []
    const registry = new WatchRegistry(
      testConfig(),
      {
        onChange: () => {},
        onPhase: async (_session, watch) => {
          emitted.push({ sha: watch.sha, phase: watch.phase.kind })
        },
        onReviewUpdate: async () => {},
      },
      instantSleep,
    )
    const oldGh: CiGh = {
      listRuns: async () => {
        entered.resolve()
        return oldResult.promise
      },
      buildReport: async () => {
        throw new Error("stale report must not be built")
      },
      findPrForBranch: async () => null,
      reviewSnapshot: async () => {
        throw new Error("stale snapshot must not be fetched")
      },
    }

    const oldWatch = registry.startWatch(SESSION, target(), oldGh)
    await entered.promise
    const newSha = "def456" as CommitSha
    await registry.startWatch(SESSION, target("main", newSha), fakeGh([[makeRun("completed", "success")]]))
    oldResult.resolve([makeRun("in_progress", null)])
    await oldWatch

    expect(registry.sessionView(SESSION).watches.map((watch) => watch.sha)).toEqual([newSha])
    expect(emitted.filter((event) => event.sha === SHA).map((event) => event.phase)).toEqual(["waiting"])
  })

  it("removing a session aborts and clears all of its watches", async () => {
    const { events } = collectPhases()
    const registry = new WatchRegistry(testConfig(), events, instantSleep)
    const first = registry.startWatch(SESSION, target("a"), fakeGh([[makeRun("in_progress", null)]]))
    const second = registry.startWatch(SESSION, target("b"), fakeGh([[makeRun("in_progress", null)]]))

    registry.remove(SESSION)
    await Promise.all([first, second])

    expect(registry.snapshot()).toEqual([])
  })

  it("keys watches by canonical repo and full destination ref", () => {
    expect(String(watchKey("ghe.example.com/acme/widget", "feature/x"))).toBe(
      "ghe.example.com/acme/widget\0refs/heads/feature/x",
    )
  })
})

describe("WatchRegistry review watching", () => {
  it("skips review polling entirely when the branch has no PR", async () => {
    const { gh, snapshotCalls } = reviewGh({
      runs: [[makeRun("in_progress", null)], [makeRun("completed", "success")]],
      pr: null,
      snapshots: [],
    })
    const { phases, events } = collectPhases()
    const registry = new WatchRegistry(testConfig(), events, instantSleep)

    await registry.startWatch(SESSION, target(), gh)

    expect(phases).toEqual(["waiting", "running", "done"])
    expect(snapshotCalls()).toBe(0)
  })

  it("skips review polling when review.enabled is false even with a PR", async () => {
    const { gh, snapshotCalls } = reviewGh({
      runs: [[makeRun("completed", "success")]],
      pr: prInfo(),
      snapshots: [],
    })
    const { phases, watches, events } = collectPhases()
    const registry = new WatchRegistry(testConfig({ review: { enabled: false } }), events, instantSleep)

    await registry.startWatch(SESSION, target(), gh)

    expect(phases).toEqual(["waiting", "done"])
    expect(snapshotCalls()).toBe(0)
    expect(phaseOf(watches, "done").report.review).toBeNull()
  })

  it("treats PR discovery failure as no PR", async () => {
    const { gh, snapshotCalls } = reviewGh({
      runs: [[makeRun("in_progress", null)], [makeRun("completed", "success")]],
      pr: "gh-error",
      snapshots: [],
    })
    const { phases, events } = collectPhases()
    const registry = new WatchRegistry(testConfig(), events, instantSleep)

    await registry.startWatch(SESSION, target(), gh)

    expect(phases).toEqual(["waiting", "running", "done"])
    expect(snapshotCalls()).toBe(0)
  })

  it("emits onReviewUpdate mid-CI exactly once for new review activity", async () => {
    const baseline = snap()
    const withComment = snap({ threads: [thread("t1", false, [comment(11)])] })
    const { gh } = reviewGh({
      runs: [
        [makeRun("in_progress", null)],
        [makeRun("in_progress", null)],
        [makeRun("completed", "success")],
      ],
      pr: prInfo(),
      snapshots: [baseline, withComment, withComment, snap({ merged: true })],
    })
    const { phases, updates, events } = collectPhases()
    const registry = new WatchRegistry(testConfig(), events, instantSleep)

    await registry.startWatch(SESSION, target(), gh)

    expect(updates).toHaveLength(1)
    expect(updates[0]?.phaseKind).toBe("running")
    expect(updates[0]?.update.snapshot).toBe(withComment)
    expect(updates[0]?.update.runs).toEqual([makeRun("in_progress", null)])
    expect(updates[0]?.update.delta.newComments.map((event) => event.comment.databaseId)).toEqual([11])
    expect(phases.filter((phase) => phase === "review-ended")).toEqual(["review-ended"])
  })

  it("skips a mid-CI cycle when the snapshot fetch fails and keeps watching", async () => {
    const baseline = snap()
    const withComment = snap({ threads: [thread("t1", false, [comment(11)])] })
    const { gh } = reviewGh({
      runs: [
        [makeRun("in_progress", null)],
        [makeRun("in_progress", null)],
        [makeRun("in_progress", null)],
        [makeRun("completed", "success")],
      ],
      pr: prInfo(),
      snapshots: [baseline, "gh-error", withComment, withComment, snap({ merged: true })],
    })
    const { phases, updates, events } = collectPhases()
    const registry = new WatchRegistry(testConfig(), events, instantSleep)

    await registry.startWatch(SESSION, target(), gh)

    expect(updates).toHaveLength(1)
    expect(updates[0]?.update.delta.newComments.map((event) => event.comment.databaseId)).toEqual([11])
    expect(phases).not.toContain("error")
    expect(phases.at(-1)).toBe("review-ended")
  })

  it("seeds the review loop with the done snapshot and does not re-notify identical state", async () => {
    const enriched = snap({ threads: [thread("t1", false, [comment(11)])] })
    const { gh } = reviewGh({
      runs: [[makeRun("completed", "success")]],
      pr: prInfo(),
      snapshots: [enriched, enriched, snap({ merged: true })],
    })
    const { phases, watches, events } = collectPhases()
    const registry = new WatchRegistry(testConfig(), events, instantSleep)

    await registry.startWatch(SESSION, target(), gh)

    expect(phaseOf(watches, "done").report.review).toBe(enriched)
    expect(phases).not.toContain("reviewing")
    expect(phases.at(-1)).toBe("review-ended")
  })

  it("reuses the last mid-CI snapshot when the fresh done snapshot fetch fails", async () => {
    const baseline = snap({ threads: [thread("t1", false, [comment(11)])] })
    const { gh } = reviewGh({
      runs: [[makeRun("in_progress", null)], [makeRun("completed", "success")]],
      pr: prInfo(),
      snapshots: [baseline, "gh-error", snap({ merged: true })],
    })
    const { phases, watches, events } = collectPhases()
    const registry = new WatchRegistry(testConfig(), events, instantSleep)

    await registry.startWatch(SESSION, target(), gh)

    expect(phaseOf(watches, "done").report.review).toBe(baseline)
    expect(phases.at(-1)).toBe("review-ended")
  })

  it("skips the review loop when no snapshot could ever be fetched", async () => {
    const { gh, snapshotCalls } = reviewGh({
      runs: [[makeRun("completed", "success")]],
      pr: prInfo(),
      snapshots: ["gh-error"],
    })
    const { phases, watches, events } = collectPhases()
    const registry = new WatchRegistry(testConfig(), events, instantSleep)

    await registry.startWatch(SESSION, target(), gh)

    expect(phases).toEqual(["waiting", "done"])
    expect(phaseOf(watches, "done").report.review).toBeNull()
    expect(snapshotCalls()).toBe(1)
  })

  it("sets the reviewing phase with the delta when new review activity arrives post-CI", async () => {
    const seedSnap = snap()
    const withHuman = snap({ threads: [thread("t1", false, [comment(21, "alice")])] })
    const { gh } = reviewGh({
      runs: [[makeRun("completed", "success")]],
      pr: prInfo(),
      snapshots: [seedSnap, withHuman, snap({ merged: true })],
    })
    const { phases, watches, events } = collectPhases()
    const registry = new WatchRegistry(testConfig(), events, instantSleep)

    await registry.startWatch(SESSION, target(), gh)

    const reviewing = phaseOf(watches, "reviewing")
    expect(reviewing.snapshot).toBe(withHuman)
    expect(reviewing.delta.newComments.map((event) => event.comment.author)).toEqual(["alice"])
    expect(phases.at(-1)).toBe("review-ended")
  })

  it("re-arms the idle deadline after a notify cycle", async () => {
    const seedSnap = snap()
    const first = snap({ threads: [thread("t1", false, [comment(21, "alice")])] })
    const second = snap({
      threads: [thread("t1", false, [comment(21, "alice")]), thread("t2", false, [comment(22, "bob")])],
    })
    const { gh } = reviewGh({
      runs: [[makeRun("completed", "success")]],
      pr: prInfo(),
      snapshots: [seedSnap, first, first, second, snap({ merged: true })],
    })
    const { phases, watches, events } = collectPhases()
    const registry = new WatchRegistry(
      testConfig({ review: { idleTimeoutMs: 60_000 } }),
      events,
      instantSleep,
      scriptedNow([0, 50_000, 50_000, 70_000, 90_000, 90_000]),
    )

    await registry.startWatch(SESSION, target(), gh)

    expect(phases.filter((phase) => phase === "reviewing")).toEqual(["reviewing", "reviewing"])
    expect(phaseOf(watches, "review-ended").reason).toBe("merged")
  })

  it("ends the review loop when the PR is merged", async () => {
    const { gh } = reviewGh({
      runs: [[makeRun("completed", "success")]],
      pr: prInfo(),
      snapshots: [snap(), snap({ merged: true })],
    })
    const { phases, watches, events } = collectPhases()
    const registry = new WatchRegistry(testConfig(), events, instantSleep)

    await registry.startWatch(SESSION, target(), gh)

    expect(phaseOf(watches, "review-ended").reason).toBe("merged")
    expect(phases).toEqual(["waiting", "done", "review-ended"])
  })

  it("ends the review loop with ready when threads resolve and the PR is clean", async () => {
    const seedSnap = snap({ threads: [thread("t1", false, [comment(11)])] })
    const resolved = snap({
      threads: [thread("t1", true, [comment(11)])],
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
    })
    const { gh } = reviewGh({
      runs: [[makeRun("completed", "success")]],
      pr: prInfo(),
      snapshots: [seedSnap, resolved],
    })
    const { watches, events } = collectPhases()
    const registry = new WatchRegistry(testConfig(), events, instantSleep)

    await registry.startWatch(SESSION, target(), gh)

    const ended = phaseOf(watches, "review-ended")
    expect(ended.reason).toBe("ready")
    expect(ended.delta.unresolved).toEqual({ from: 1, to: 0 })
  })

  it("ends the review loop with idle-timeout when nothing changes past the deadline", async () => {
    const { gh } = reviewGh({
      runs: [[makeRun("completed", "success")]],
      pr: prInfo(),
      snapshots: [snap(), snap()],
    })
    const { phases, watches, events } = collectPhases()
    const registry = new WatchRegistry(
      testConfig({ review: { idleTimeoutMs: 60_000 } }),
      events,
      instantSleep,
      scriptedNow([0, 61_000]),
    )

    await registry.startWatch(SESSION, target(), gh)

    expect(phaseOf(watches, "review-ended").reason).toBe("idle-timeout")
    expect(phases).toEqual(["waiting", "done", "review-ended"])
  })

  /** Drives a watch into the review loop, blocks it on a snapshot fetch, aborts, then resolves the fetch. */
  async function runReviewAbortScenario(abort: (registry: WatchRegistry) => void): Promise<string[]> {
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<ReviewSnapshot>()
    let calls = 0
    const gh: CiGh = {
      listRuns: async () => [makeRun("completed", "success")],
      buildReport: async (pushTarget) => makeReport(pushTarget, prInfo(), [makeRun("completed", "success")]),
      findPrForBranch: async () => prInfo(),
      reviewSnapshot: async () => {
        calls += 1
        if (calls === 1) return snap()
        entered.resolve()
        return gate.promise
      },
    }
    const { phases, events } = collectPhases()
    const registry = new WatchRegistry(testConfig(), events, instantSleep)

    const watchPromise = registry.startWatch(SESSION, target(), gh)
    await entered.promise
    abort(registry)
    gate.resolve(snap({ threads: [thread("t1", false, [comment(11)])] }))
    await watchPromise
    return phases
  }

  it("stops the review loop without further phases when the session is disabled", async () => {
    const phases = await runReviewAbortScenario((registry) => registry.setEnabled(SESSION, false))
    expect(phases).toEqual(["waiting", "done"])
  })

  it("stops the review loop without further phases when the session is removed", async () => {
    const phases = await runReviewAbortScenario((registry) => registry.remove(SESSION))
    expect(phases).toEqual(["waiting", "done"])
  })

  it("blocks stale review phases when a new push supersedes the watch", async () => {
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<ReviewSnapshot>()
    let calls = 0
    const oldGh: CiGh = {
      listRuns: async () => [makeRun("completed", "success")],
      buildReport: async (pushTarget) => makeReport(pushTarget, prInfo(), [makeRun("completed", "success")]),
      findPrForBranch: async () => prInfo(),
      reviewSnapshot: async () => {
        calls += 1
        if (calls === 1) return snap()
        entered.resolve()
        return gate.promise
      },
    }
    const emitted: Array<{ readonly sha: CommitSha; readonly phase: string }> = []
    const registry = new WatchRegistry(
      testConfig(),
      {
        onChange: () => {},
        onPhase: async (_session, watch) => {
          emitted.push({ sha: watch.sha, phase: watch.phase.kind })
        },
        onReviewUpdate: async () => {},
      },
      instantSleep,
    )

    const oldWatch = registry.startWatch(SESSION, target(), oldGh)
    await entered.promise
    const newSha = "def456" as CommitSha
    await registry.startWatch(SESSION, target("main", newSha), fakeGh([[makeRun("completed", "success")]]))
    gate.resolve(snap({ threads: [thread("t1", false, [comment(11)])] }))
    await oldWatch

    expect(emitted.filter((event) => event.sha === SHA).map((event) => event.phase)).toEqual([
      "waiting",
      "done",
    ])
    expect(emitted.filter((event) => event.sha === newSha).map((event) => event.phase)).toEqual([
      "waiting",
      "done",
    ])
  })
})
