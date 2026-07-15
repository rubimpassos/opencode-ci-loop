import { describe, expect, it } from "bun:test"
import { isReportClean, renderPromptReport, summarizeRuns } from "./render.ts"
import type { CiReport, CommitSha, WorkflowRun } from "./types.ts"

function makeRun(overrides: Partial<WorkflowRun>): WorkflowRun {
  return {
    id: 1,
    name: "ci",
    workflowName: "CI",
    status: "completed",
    conclusion: "success",
    url: "https://github.com/o/r/actions/runs/1",
    branch: "main",
    ...overrides,
  }
}

function makeReport(runs: readonly WorkflowRun[], failedLogs: CiReport["failedLogs"] = []): CiReport {
  return { sha: "abcdef1234567890" as CommitSha, branch: "main", runs, failedLogs }
}

describe("summarizeRuns", () => {
  it("reports passing when all runs completed successfully", () => {
    const runs = [makeRun({}), makeRun({ id: 2 })]
    expect(summarizeRuns(runs)).toBe("2/2 passing")
  })

  it("reports failing count when a completed run failed", () => {
    const runs = [makeRun({}), makeRun({ id: 2, conclusion: "failure" })]
    expect(summarizeRuns(runs)).toBe("1/2 failing")
  })

  it("reports progress with failures while runs are still in progress", () => {
    const runs = [
      makeRun({ conclusion: "failure" }),
      makeRun({ id: 2, status: "in_progress", conclusion: null }),
    ]
    expect(summarizeRuns(runs)).toBe("1/2 completed (1 failing)")
  })
})

describe("isReportClean", () => {
  it("is clean when every run succeeded or was skipped", () => {
    expect(isReportClean(makeReport([makeRun({}), makeRun({ id: 2, conclusion: "skipped" })]))).toBe(true)
  })

  it("is dirty when any run failed", () => {
    expect(isReportClean(makeReport([makeRun({ conclusion: "failure" })]))).toBe(false)
  })
})

describe("renderPromptReport", () => {
  it("tells the agent no action is needed when CI is green", () => {
    const report = makeReport([makeRun({})])
    const text = renderPromptReport(report)
    expect(text).toContain("abcdef12")
    expect(text).toContain("Nenhuma ação necessária")
    expect(text).not.toContain("Logs das falhas")
  })

  it("includes failure logs and fix instructions when CI failed", () => {
    const report = makeReport(
      [makeRun({ conclusion: "failure" })],
      [{ runId: 1, runName: "ci", logTail: "AssertionError: expected 1 to be 2" }],
    )
    const text = renderPromptReport(report)
    expect(text).toContain("Logs das falhas")
    expect(text).toContain("AssertionError: expected 1 to be 2")
    expect(text).toContain("corrija a causa raiz")
  })
})
