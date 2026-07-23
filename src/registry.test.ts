import { describe, expect, it } from "bun:test"
import { type CiGh, WatchRegistry, watchKey } from "./registry.ts"
import {
  type CommitSha,
  PluginConfigSchema,
  type PushTarget,
  type SessionId,
  type Watch,
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

/** Fake CiGh: each listRuns call consumes the next scripted response. */
function fakeGh(script: readonly (readonly WorkflowRun[])[]): CiGh {
  let call = 0
  return {
    listRuns: async () => script[Math.min(call++, script.length - 1)] ?? [],
    buildReport: async (pushTarget) => ({
      sha: pushTarget.sha,
      branch: pushTarget.branch,
      repo: pushTarget.repo,
      sourceKind: pushTarget.sourceKind,
      directory: pushTarget.directory,
      runs: script[script.length - 1] ?? [],
      failedLogs: [],
      pr: null,
      ruleFailures: [],
    }),
  }
}

function testConfig() {
  return PluginConfigSchema.parse({
    pollIntervalMs: 1000,
    initialDelayMs: 0,
    dashboard: { enabled: false },
  })
}

const instantSleep = async (): Promise<void> => {}

function collectPhases(): { phases: string[]; events: ConstructorParameters<typeof WatchRegistry>[1] } {
  const phases: string[] = []
  return {
    phases,
    events: {
      onChange: () => {},
      onPhase: async (_session: SessionId, watch: Watch) => {
        phases.push(watch.phase.kind)
      },
    },
  }
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
