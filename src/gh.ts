import { z } from "zod"
import {
  type CiReport,
  type CommitSha,
  type FailedRunLog,
  PR_MERGE_STATE_STATUSES,
  PR_MERGEABLE_STATES,
  PR_REVIEW_DECISIONS,
  PR_STATES,
  type PrInfo,
  RUN_CONCLUSIONS,
  RUN_STATUSES,
  type WorkflowRun,
} from "./types.ts"

export type ExecResult = {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** Runs a command (argv) in a directory. Injectable for tests. */
export type Exec = (argv: readonly string[], cwd: string) => Promise<ExecResult>

export class GhError extends Error {
  constructor(
    readonly argv: readonly string[],
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(`gh exited ${exitCode}: ${stderr.slice(0, 200)}`)
    this.name = "GhError"
  }
}

const GhRunSchema = z.object({
  databaseId: z.number(),
  displayTitle: z.string().catch(""),
  workflowName: z.string().catch(""),
  status: z.enum(RUN_STATUSES).catch("in_progress"),
  conclusion: z
    .enum(RUN_CONCLUSIONS)
    .nullable()
    .catch(null)
    .or(z.literal("").transform(() => null)),
  url: z.string(),
  headBranch: z.string().catch(""),
})

const GhRunListSchema = z.array(GhRunSchema)

const GhPrSchema = z.object({
  number: z.number(),
  title: z.string().catch(""),
  url: z.string(),
  state: z.enum(PR_STATES).catch("OPEN"),
  isDraft: z.boolean().catch(false),
  mergeable: z.enum(PR_MERGEABLE_STATES).catch("UNKNOWN"),
  mergeStateStatus: z.enum(PR_MERGE_STATE_STATUSES).catch("UNKNOWN"),
  reviewDecision: z
    .enum(PR_REVIEW_DECISIONS)
    .nullable()
    .catch(null)
    .or(z.literal("").transform(() => null)),
})

export function parseRunList(json: string): readonly WorkflowRun[] {
  const parsed = GhRunListSchema.parse(JSON.parse(json))
  return parsed.map((run) => ({
    id: run.databaseId,
    name: run.displayTitle,
    workflowName: run.workflowName,
    status: run.status,
    conclusion: run.conclusion,
    url: run.url,
    branch: run.headBranch,
  }))
}

export const bunExec: Exec = async (argv, cwd) => {
  const proc = Bun.spawn([...argv], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

const RUN_LIST_FIELDS = "databaseId,displayTitle,workflowName,status,conclusion,url,headBranch"
const PR_FIELDS = "number,title,url,state,isDraft,mergeable,mergeStateStatus,reviewDecision"
const NO_PR_MESSAGE = "no pull requests found for branch"

export class GhClient {
  private repoUrl: string | null = null

  constructor(
    private readonly exec: Exec,
    private readonly directory: string,
  ) {}

  async headSha(): Promise<CommitSha> {
    const result = await this.run(["git", "rev-parse", "HEAD"])
    return result.stdout.trim() as CommitSha
  }

  /**
   * URL of the repo the push went to (remote from @{push}, origin fallback).
   * Needed because `gh` resolves the default to the `upstream` remote on forks.
   */
  async pushRepoUrl(): Promise<string> {
    if (this.repoUrl) return this.repoUrl
    const pushRef = await this.exec(
      ["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{push}"],
      this.directory,
    )
    const remote = pushRef.exitCode === 0 ? (pushRef.stdout.trim().split("/")[0] ?? "origin") : "origin"
    const url = await this.run(["git", "remote", "get-url", remote])
    this.repoUrl = url.stdout.trim().replace(/\.git$/, "")
    return this.repoUrl
  }

  async currentBranch(): Promise<string> {
    const result = await this.run(["git", "rev-parse", "--abbrev-ref", "HEAD"])
    return result.stdout.trim()
  }

  async listRuns(sha: CommitSha): Promise<readonly WorkflowRun[]> {
    const repo = await this.pushRepoUrl()
    const result = await this.run([
      "gh",
      "run",
      "list",
      "-R",
      repo,
      "--commit",
      sha,
      "--json",
      RUN_LIST_FIELDS,
      "--limit",
      "30",
    ])
    return parseRunList(result.stdout)
  }

  async failedLog(run: WorkflowRun, maxLines: number): Promise<FailedRunLog> {
    const repo = await this.pushRepoUrl()
    const result = await this.exec(
      ["gh", "run", "view", "-R", repo, String(run.id), "--log-failed"],
      this.directory,
    )
    const lines = result.stdout.split("\n")
    const logTail = lines.slice(Math.max(0, lines.length - maxLines)).join("\n")
    return { runId: run.id, runName: run.name, logTail }
  }

  async findPrForBranch(branch: string): Promise<PrInfo | null> {
    const repo = await this.pushRepoUrl()
    const argv = ["gh", "pr", "view", branch, "-R", repo, "--json", PR_FIELDS] as const
    const result = await this.exec(argv, this.directory)
    if (result.exitCode !== 0) {
      if (result.stderr.includes(NO_PR_MESSAGE)) return null
      throw new GhError(argv, result.exitCode, result.stderr)
    }
    const pr = GhPrSchema.parse(JSON.parse(result.stdout))
    return pr.state === "OPEN" ? pr : null
  }

  async buildReport(sha: CommitSha, branch: string, maxLogLines: number): Promise<CiReport> {
    const [runs, pr] = await Promise.all([this.listRuns(sha), this.findPrForBranch(branch)])
    const failed = runs.filter((run) => run.conclusion === "failure" || run.conclusion === "timed_out")
    const failedLogs = await Promise.all(failed.map((run) => this.failedLog(run, maxLogLines)))
    return { sha, branch, runs, failedLogs, pr }
  }

  private async run(argv: readonly string[]): Promise<ExecResult> {
    const result = await this.exec(argv, this.directory)
    if (result.exitCode !== 0) {
      throw new GhError(argv, result.exitCode, result.stderr)
    }
    return result
  }
}
