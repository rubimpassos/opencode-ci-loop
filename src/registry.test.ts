import { describe, expect, it } from "bun:test"
import type { GhClient } from "./gh.ts"
import { WatchRegistry } from "./registry.ts"
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

/** Fake GhClient: cada chamada a listRuns consome a próxima resposta do roteiro. */
function fakeGh(script: readonly (readonly WorkflowRun[])[]): GhClient {
  let call = 0
  const fake = {
    listRuns: async () => script[Math.min(call++, script.length - 1)] ?? [],
    buildReport: async (sha: CommitSha, branch: string) => ({
      sha,
      branch,
      runs: script[script.length - 1] ?? [],
      failedLogs: [],
    }),
  }
  return fake as Pick<GhClient, "listRuns" | "buildReport"> as GhClient
}

function testConfig() {
  return PluginConfigSchema.parse({
    pollIntervalMs: 1000,
    initialDelayMs: 0,
    dashboard: { enabled: false },
  })
}

const instantSleep = async (): Promise<void> => {}

function collectPhases(): { phases: string[]; events: ConstructorParameters<typeof WatchRegistry>[2] } {
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
    const registry = new WatchRegistry(gh, testConfig(), events, instantSleep)

    await registry.startWatch(SESSION, SHA, "main")

    expect(phases).toEqual(["waiting", "running", "done"])
    const state = registry.snapshot().find((s) => s.sessionID === SESSION)
    expect(state?.watch?.phase.kind).toBe("done")
  })

  it("respects autoWatch default and per-session disable", () => {
    const { events } = collectPhases()
    const registry = new WatchRegistry(fakeGh([[]]), testConfig(), events, instantSleep)

    expect(registry.isEnabled(SESSION)).toBe(true)
    registry.setEnabled(SESSION, false)
    expect(registry.isEnabled(SESSION)).toBe(false)
  })

  it("disabling a session aborts its active watch", async () => {
    const runningForever = fakeGh([[makeRun("in_progress", null)]])
    const { phases, events } = collectPhases()
    const registry = new WatchRegistry(
      runningForever,
      testConfig(),
      events,
      {
        // sleep controlado: desabilita a sessão durante a primeira espera
        0: instantSleep,
      }[0],
    )

    const watchPromise = registry.startWatch(SESSION, SHA, "main")
    registry.setEnabled(SESSION, false)
    await watchPromise

    expect(phases).not.toContain("done")
    expect(phases).not.toContain("timed-out")
  })

  it("reports error phase when gh fails", async () => {
    const broken = {
      listRuns: async () => {
        throw new Error("gh not authenticated")
      },
    } as Pick<GhClient, "listRuns"> as GhClient
    const { phases, events } = collectPhases()
    const registry = new WatchRegistry(broken, testConfig(), events, instantSleep)

    await registry.startWatch(SESSION, SHA, "main")

    expect(phases).toEqual(["waiting", "error"])
  })
})
