import { describe, expect, it } from "bun:test"
import { type Exec, type ExecResult, GhClient, GhError, parseRunList } from "./gh.ts"
import type { CommitSha, PushTarget } from "./types.ts"

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

const PR_JSON = JSON.stringify({
  number: 12,
  title: "feat: nova feature",
  url: "https://github.com/o/r/pull/12",
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: "APPROVED",
})

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

function scriptedExec(script: Record<string, string | ExecResult>): Exec {
  return async (argv) => {
    const key = argv.join(" ")
    for (const [pattern, response] of Object.entries(script)) {
      if (key.startsWith(pattern)) {
        return typeof response === "string" ? { exitCode: 0, stdout: response, stderr: "" } : response
      }
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
  const target: PushTarget = {
    sha,
    branch: "feat/x",
    repo: "github.com/o/r",
    repoUrl: "https://github.com/o/r",
    directory: "/repo-feature",
    sourceKind: "linked-worktree",
  }

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

  it("uses an explicit push repo without consulting the working directory", async () => {
    const client = new GhClient(scriptedExec({}), "/wrong-repo", "https://ghe.example.com/acme/widget")

    expect(await client.pushRepoUrl()).toBe("https://ghe.example.com/acme/widget")
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

  it("filters same-commit runs to the destination branch", async () => {
    const mixedBranches = JSON.stringify([
      ...JSON.parse(RUN_LIST_JSON),
      {
        databaseId: 103,
        displayTitle: "release",
        workflowName: "CI",
        status: "completed",
        conclusion: "success",
        url: "https://github.com/o/r/actions/runs/103",
        headBranch: "release",
      },
    ])
    const client = new GhClient(scriptedExec({ "gh run list": mixedBranches }), "/repo", target.repoUrl)

    const runs = await client.listRuns(sha, "feat/x")

    expect(runs.map((run) => run.branch)).toEqual(["feat/x", "feat/x"])
  })

  it("finds the open PR for a branch", async () => {
    const client = new GhClient(
      scriptedExec({
        ...GIT_REMOTE_SCRIPT,
        "gh pr view": PR_JSON,
      }),
      "/repo",
    )

    const pr = await client.findPrForBranch("feat/x")

    expect(pr).toEqual({
      number: 12,
      title: "feat: nova feature",
      url: "https://github.com/o/r/pull/12",
      state: "OPEN",
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: "APPROVED",
    })
  })

  it("returns null when no PR exists for the branch", async () => {
    const client = new GhClient(
      scriptedExec({
        ...GIT_REMOTE_SCRIPT,
        "gh pr view": {
          exitCode: 1,
          stdout: "",
          stderr: 'no pull requests found for branch "feat/x"',
        },
      }),
      "/repo",
    )

    expect(await client.findPrForBranch("feat/x")).toBeNull()
  })

  it("propagates gh failures other than a missing PR", async () => {
    const client = new GhClient(
      scriptedExec({
        ...GIT_REMOTE_SCRIPT,
        "gh pr view": { exitCode: 1, stdout: "", stderr: "authentication required" },
      }),
      "/repo",
    )

    expect(client.findPrForBranch("feat/x")).rejects.toBeInstanceOf(GhError)
  })

  it("builds a report with failure logs only for failed runs", async () => {
    const exec = scriptedExec({
      ...GIT_REMOTE_SCRIPT,
      "gh run list": RUN_LIST_JSON.replace('"in_progress"', '"completed"').replace('""', '"success"'),
      "gh run view": "line1\nline2\nBOOM: test failed\n",
      "gh pr view": PR_JSON,
    })
    const client = new GhClient(exec, "/repo", target.repoUrl)

    const report = await client.buildReport(target, 2)

    expect(report.runs).toHaveLength(2)
    expect(report.failedLogs).toHaveLength(1)
    expect(report.failedLogs[0]?.runId).toBe(101)
    expect(report.failedLogs[0]?.logTail).toBe("BOOM: test failed\n")
    expect(report.pr?.number).toBe(12)
    expect(report.repo).toBe("github.com/o/r")
    expect(report.sourceKind).toBe("linked-worktree")
    expect(report.directory).toBe("/repo-feature")
  })

  it("throws GhError with command context when gh fails", async () => {
    const client = new GhClient(scriptedExec({}), "/repo")
    expect(client.headSha()).rejects.toBeInstanceOf(GhError)
  })
})
