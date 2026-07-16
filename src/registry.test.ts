import { describe, expect, it } from "bun:test"
import { type CiGh, WatchRegistry } from "./registry.ts"
import { type CommitSha, PluginConfigSchema, type SessionId, type Watch, type WorkflowRun } from "./types.ts"

const SESSION = "ses_test" as SessionId
const SHA = "abc123" as CommitSha

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

/** Fake CiGh: cada chamada a listRuns consome a próxima resposta do roteiro. */
function fakeGh(script: readonly (readonly WorkflowRun[])[]): CiGh {
  let call = 0
  return {
    listRuns: async () => script[Math.min(call++, script.length - 1)] ?? [],
    buildReport: async (sha: CommitSha, branch: string) => ({
      sha,
      branch,
      runs: script[script.length - 1] ?? [],
      failedLogs: [],
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

    await registry.startWatch(SESSION, SHA, "main", gh)

    expect(phases).toEqual(["waiting", "running", "done"])
    const state = registry.snapshot().find((s) => s.sessionID === SESSION)
    expect(state?.watch?.phase.kind).toBe("done")
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
    expect(view).toEqual({ sessionID: SESSION, enabled: true, watch: null, directory: null })
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

    const watchPromise = registry.startWatch(SESSION, SHA, "main", runningForever)
    registry.setEnabled(SESSION, false)
    await watchPromise

    expect(phases).not.toContain("done")
    expect(phases).not.toContain("timed-out")
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

    await registry.startWatch(SESSION, SHA, "main", broken)

    expect(phases).toEqual(["waiting", "error"])
  })
})
