import { afterAll, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { type Exec, GhClient, GhError } from "../src/gh.ts"
import { unresolvedThreadCount } from "../src/render-review.ts"
import type { CommitSha, PushTarget } from "../src/types.ts"
import {
  EXTERNAL_STATUS_CONTEXT,
  FAILED_LOG_TAIL,
  FIXTURE_BRANCH,
  FIXTURE_REPO_URL,
  FIXTURE_SLUG,
  ghState,
  repoState,
  writeState,
} from "./fixtures.mjs"

mkdirSync("/tmp/opencode", { recursive: true })
const scratch = mkdtempSync("/tmp/opencode/ci-loop-fake-gh-")
const binDir = join(scratch, "bin")
mkdirSync(binDir)
symlinkSync(join(import.meta.dir, "fake-gh.mjs"), join(binDir, "gh"))
const statePath = join(scratch, "state.json")
const logPath = join(scratch, "gh.log")
const ghEnv = {
  ...process.env,
  PATH: `${binDir}:${process.env.PATH ?? ""}`,
  FAKE_GH_STATE: statePath,
  FAKE_GH_LOG: logPath,
}

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** Resolves `gh` through PATH, exactly as A's bunExec does inside the OpenCode child. */
const fakeGhExec: Exec = async (argv, cwd) => {
  const proc = Bun.spawn([...argv], { cwd, env: ghEnv, stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

const SHA = "a".repeat(40) as CommitSha
const SHA2 = "b".repeat(40) as CommitSha
const target = (sha: CommitSha): PushTarget => ({
  sha,
  branch: FIXTURE_BRANCH,
  repo: `github.com/${FIXTURE_SLUG}`,
  repoUrl: FIXTURE_REPO_URL,
  directory: scratch,
  sourceKind: "session",
})
const client = () => new GhClient(fakeGhExec, scratch, FIXTURE_REPO_URL)
const loggedKinds = () =>
  readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).kind)

beforeEach(() => rmSync(logPath, { force: true }))

describe("fake gh through A's real GhClient parsers", () => {
  it("advances queued → in_progress as the state file is atomically replaced", async () => {
    writeState(
      statePath,
      ghState({ repos: { [FIXTURE_SLUG]: repoState({ commits: [{ sha: SHA, stage: "queued" }] }) } }),
    )
    const queued = await client().listRuns(SHA, FIXTURE_BRANCH)
    writeState(
      statePath,
      ghState({ repos: { [FIXTURE_SLUG]: repoState({ commits: [{ sha: SHA, stage: "in_progress" }] }) } }),
    )

    const running = await client().listRuns(SHA, FIXTURE_BRANCH)

    expect(queued.map((run) => run.status)).toEqual(["queued", "queued"])
    expect(running.map((run) => run.status)).toEqual(["in_progress", "completed"])
  })

  it("builds a failure report with log tail, failing external StatusContext, blocked PR and rule failures", async () => {
    const repo = repoState({ blocked: true, commits: [{ sha: SHA, stage: "failure" }] })
    writeState(statePath, ghState({ repos: { [FIXTURE_SLUG]: repo } }))

    const report = await client().buildReport(target(SHA), 50)

    expect(report.runs.map((run) => run.conclusion)).toEqual(["failure", "success"])
    expect(report.failedLogs[0]?.logTail).toContain(FAILED_LOG_TAIL)
    expect(report.pr?.mergeStateStatus).toBe("BLOCKED")
    expect(report.pr?.commitCount).toBe(1)
    expect(report.pr?.checks).toContainEqual(
      expect.objectContaining({ name: EXTERNAL_STATUS_CONTEXT, workflowName: null, status: "failing" }),
    )
    expect(report.ruleFailures).toEqual([
      { ruleType: "required_status_checks", message: `${EXTERNAL_STATUS_CONTEXT} failing` },
    ])
    expect(loggedKinds().sort()).toEqual([
      "pr-view",
      "pulls-commits",
      "rule-suite",
      "rule-suites",
      "run-list",
      "run-view",
    ])
  })

  it("serves a green variant for a second commit beside the failed first one", async () => {
    const commits = [
      { sha: SHA, stage: "failure" as const },
      { sha: SHA2, stage: "green" as const },
    ]
    writeState(statePath, ghState({ repos: { [FIXTURE_SLUG]: repoState({ commits }) } }))

    const report = await client().buildReport(target(SHA2), 50)

    expect(report.runs.map((run) => run.conclusion)).toEqual(["success", "success"])
    expect(report.failedLogs).toEqual([])
    expect(report.pr?.mergeStateStatus).toBe("CLEAN")
    expect(report.pr?.commitCount).toBe(2)
  })

  it("parses review deltas from the REVIEW_SNAPSHOT_QUERY graphql call", async () => {
    const withDelta = (reviewDelta: 1 | 2) =>
      ghState({
        repos: { [FIXTURE_SLUG]: repoState({ reviewDelta, commits: [{ sha: SHA, stage: "green" }] }) },
      })
    writeState(statePath, withDelta(1))
    const first = await client().reviewSnapshot(1)
    writeState(statePath, withDelta(2))

    const second = await client().reviewSnapshot(1)

    expect(unresolvedThreadCount(first)).toBe(1)
    expect(unresolvedThreadCount(second)).toBe(0)
    expect(second.threads[0]?.comments.at(-1)?.body).toEndWith("_🤖 via agent_")
    expect(second.comments.map((comment) => comment.databaseId)).toEqual([9201])
  })

  it("reports no PR when the branch has none", async () => {
    writeState(
      statePath,
      ghState({
        repos: { [FIXTURE_SLUG]: repoState({ withPr: false, commits: [{ sha: SHA, stage: "green" }] }) },
      }),
    )

    expect(await client().findPrForBranch(FIXTURE_BRANCH)).toBeNull()
  })

  it("surfaces a refused call as GhError and malformed output as a parse failure", async () => {
    const repos = { [FIXTURE_SLUG]: repoState({ commits: [{ sha: SHA, stage: "green" }] }) }
    writeState(
      statePath,
      ghState({
        repos,
        overrides: {
          "pr-view": { exitCode: 4, stderr: "HTTP 401: Bad credentials" },
          graphql: { stdout: "{not json" },
        },
      }),
    )

    expect(client().findPrForBranch(FIXTURE_BRANCH)).rejects.toBeInstanceOf(GhError)
    expect(client().reviewSnapshot(1)).rejects.toBeInstanceOf(SyntaxError)
  })
})

describe("fake gh argv strictness", () => {
  it.each([
    [["auth", "status"]],
    [["run", "list", "-R", FIXTURE_REPO_URL, "--commit", SHA, "--json", "databaseId"]],
    [["api", "graphql", "-f", "query=query { viewer { login } }"]],
  ])("fails nonzero for unscripted argv %j", async (argv) => {
    writeState(statePath, ghState({}))

    const result = await fakeGhExec(["gh", ...argv], scratch)

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("fake-gh: unscripted argv")
  })
})
