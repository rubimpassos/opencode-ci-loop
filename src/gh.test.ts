import { describe, expect, it } from "bun:test"
import { type Exec, GhClient, GhError, parseRunList } from "./gh.ts"
import type { CommitSha } from "./types.ts"

const RUN_LIST_JSON = JSON.stringify([
  {
    databaseId: 101,
    displayTitle: "feat: nova feature",
    workflowName: "CI",
    status: "completed",
    conclusion: "failure",
    url: "https://github.com/o/r/actions/runs/101",
    headBranch: "feat/x",
  },
  {
    databaseId: 102,
    displayTitle: "feat: nova feature",
    workflowName: "Deploy",
    status: "in_progress",
    conclusion: "",
    url: "https://github.com/o/r/actions/runs/102",
    headBranch: "feat/x",
  },
])

describe("parseRunList", () => {
  it("parses gh run list JSON into typed workflow runs", () => {
    const runs = parseRunList(RUN_LIST_JSON)
    expect(runs).toHaveLength(2)
    expect(runs[0]?.id).toBe(101)
    expect(runs[0]?.conclusion).toBe("failure")
    expect(runs[1]?.conclusion).toBeNull()
    expect(runs[1]?.status).toBe("in_progress")
  })
})

function scriptedExec(script: Record<string, string>): Exec {
  return async (argv) => {
    const key = argv.join(" ")
    for (const [pattern, stdout] of Object.entries(script)) {
      if (key.startsWith(pattern)) return { exitCode: 0, stdout, stderr: "" }
    }
    return { exitCode: 1, stdout: "", stderr: `no script for: ${key}` }
  }
}

const GIT_REMOTE_SCRIPT = {
  "git rev-parse --abbrev-ref --symbolic-full-name @{push}": "origin/feat/x\n",
  "git remote get-url origin": "https://github.com/o/r.git\n",
}

describe("GhClient", () => {
  const sha = "abc123" as CommitSha

  it("resolves the push repo from @{push} instead of gh's default (upstream in forks)", async () => {
    const client = new GhClient(scriptedExec(GIT_REMOTE_SCRIPT), "/repo")
    expect(await client.pushRepoUrl()).toBe("https://github.com/o/r")
  })

  it("falls back to origin when the branch has no @{push} target", async () => {
    const client = new GhClient(
      scriptedExec({ "git remote get-url origin": "https://github.com/o/r.git\n" }),
      "/repo",
    )
    expect(await client.pushRepoUrl()).toBe("https://github.com/o/r")
  })

  it("targets gh commands at the push repo", async () => {
    const seen: string[] = []
    const scripted = scriptedExec({
      ...GIT_REMOTE_SCRIPT,
      "gh run list": RUN_LIST_JSON,
    })
    const spying: typeof scripted = async (argv, cwd) => {
      seen.push(argv.join(" "))
      return scripted(argv, cwd)
    }
    const client = new GhClient(spying, "/repo")

    await client.listRuns(sha)

    expect(seen.some((cmd) => cmd.startsWith("gh run list -R https://github.com/o/r "))).toBe(true)
  })

  it("builds a report with failure logs only for failed runs", async () => {
    const exec = scriptedExec({
      ...GIT_REMOTE_SCRIPT,
      "gh run list": RUN_LIST_JSON.replace('"in_progress"', '"completed"').replace('""', '"success"'),
      "gh run view": "line1\nline2\nBOOM: test failed\n",
    })
    const client = new GhClient(exec, "/repo")

    const report = await client.buildReport(sha, "feat/x", 2)

    expect(report.runs).toHaveLength(2)
    expect(report.failedLogs).toHaveLength(1)
    expect(report.failedLogs[0]?.runId).toBe(101)
    expect(report.failedLogs[0]?.logTail).toBe("BOOM: test failed\n")
  })

  it("throws GhError with command context when gh fails", async () => {
    const client = new GhClient(scriptedExec({}), "/repo")
    expect(client.headSha()).rejects.toBeInstanceOf(GhError)
  })
})
