import { z } from "zod"
import {
  type CiReport,
  type CommitSha,
  type FailedRunLog,
  PR_MERGE_STATE_STATUSES,
  PR_MERGEABLE_STATES,
  PR_REVIEW_DECISIONS,
  PR_STATES,
  type PrCheck,
  type PrCheckStatus,
  type PrInfo,
  type PushTarget,
  RUN_CONCLUSIONS,
  RUN_STATUSES,
  type RuleFailure,
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
  statusCheckRollup: z.array(z.unknown()).catch([]),
})

const GhCheckRunSchema = z.object({
  __typename: z.literal("CheckRun"),
  name: z.string().catch(""),
  status: z.string().catch(""),
  conclusion: z.string().nullable().catch(null),
  detailsUrl: z.string().nullable().catch(null),
  workflowName: z.string().nullable().catch(null),
})

const GhStatusContextSchema = z.object({
  __typename: z.literal("StatusContext"),
  context: z.string().catch(""),
  state: z.string().catch(""),
  targetUrl: z.string().nullable().catch(null),
})

const GhRollupItemSchema = z.discriminatedUnion("__typename", [GhCheckRunSchema, GhStatusContextSchema])

const RuleSuiteListSchema = z.array(z.object({ id: z.number(), after_sha: z.string().catch("") })).catch([])

const RuleSuiteDetailSchema = z
  .object({
    rule_evaluations: z
      .array(
        z.object({
          rule_type: z.string().catch("unknown"),
          result: z.string().catch(""),
          details: z.string().nullable().catch(null),
        }),
      )
      .catch([]),
  })
  .catch({ rule_evaluations: [] })

function checkRunStatus(status: string, conclusion: string | null): PrCheckStatus {
  if (status !== "COMPLETED") return "pending"
  switch (conclusion) {
    case "SUCCESS":
      return "passing"
    case "NEUTRAL":
    case "SKIPPED":
      return "skipped"
    case "FAILURE":
    case "TIMED_OUT":
    case "CANCELLED":
    case "ACTION_REQUIRED":
    case "STARTUP_FAILURE":
    case "STALE":
      return "failing"
    default:
      return "pending"
  }
}

function statusContextStatus(state: string): PrCheckStatus {
  switch (state) {
    case "SUCCESS":
      return "passing"
    case "FAILURE":
    case "ERROR":
      return "failing"
    default:
      return "pending"
  }
}

export function parsePrChecks(rollup: readonly unknown[]): readonly PrCheck[] {
  const checks: PrCheck[] = []
  for (const item of rollup) {
    const parsed = GhRollupItemSchema.safeParse(item)
    if (!parsed.success) continue
    if (parsed.data.__typename === "CheckRun") {
      checks.push({
        name: parsed.data.name,
        workflowName: parsed.data.workflowName,
        status: checkRunStatus(parsed.data.status, parsed.data.conclusion),
        state: parsed.data.conclusion || parsed.data.status,
        url: parsed.data.detailsUrl,
      })
    } else {
      checks.push({
        name: parsed.data.context,
        workflowName: null,
        status: statusContextStatus(parsed.data.state),
        state: parsed.data.state,
        url: parsed.data.targetUrl,
      })
    }
  }
  return checks
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
}

export function repoRef(repoUrl: string): { readonly host: string; readonly slug: string } | null {
  const scp = repoUrl.match(/^git@([^:]+):(.+?)(?:\.git)?$/)
  if (scp?.[1] !== undefined && scp[2] !== undefined) return { host: scp[1], slug: scp[2] }
  let parsed: URL
  try {
    parsed = new URL(repoUrl)
  } catch (error) {
    if (error instanceof TypeError) return null
    throw error
  }
  const slug = parsed.pathname.replace(/^\/+/, "").replace(/\.git$/, "")
  if (slug.split("/").length !== 2) return null
  return { host: parsed.host, slug }
}

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
const PR_FIELDS = "number,title,url,state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup"
const NO_PR_MESSAGE = "no pull requests found for branch"

export class GhClient {
  private repoUrl: string | null = null

  constructor(
    private readonly exec: Exec,
    private readonly directory: string,
    repoOverride?: string,
  ) {
    this.repoUrl = repoOverride ?? null
  }

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

  async listRuns(sha: CommitSha, branch?: string): Promise<readonly WorkflowRun[]> {
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
      "100",
    ])
    const runs = parseRunList(result.stdout)
    return branch === undefined ? runs : runs.filter((run) => run.branch === branch)
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
    const raw = GhPrSchema.parse(JSON.parse(result.stdout))
    if (raw.state !== "OPEN") return null
    const { statusCheckRollup, ...pr } = raw
    return {
      ...pr,
      commitCount: await this.prCommitCount(pr.number),
      checks: parsePrChecks(statusCheckRollup),
    }
  }

  /** Best-effort: rebase merges are capped at 100 commits, so the count is a merge blocker signal. */
  private async prCommitCount(prNumber: number): Promise<number | null> {
    const ref = repoRef(await this.pushRepoUrl())
    if (ref === null) return null
    const result = await this.exec(
      ["gh", "api", "--hostname", ref.host, `repos/${ref.slug}/pulls/${prNumber}`, "--jq", ".commits"],
      this.directory,
    )
    if (result.exitCode !== 0) return null
    const count = Number.parseInt(result.stdout.trim(), 10)
    return Number.isNaN(count) ? null : count
  }

  /**
   * Best-effort: names the exact ruleset rules that failed for the branch (e.g. commit_message_pattern).
   * `mergeStateStatus` alone only says BLOCKED; the rule-suites API is the only source of the rule names.
   * Requires push access to the repo — returns [] on any API error.
   */
  async ruleSuiteFailures(branch: string, sha: CommitSha): Promise<readonly RuleFailure[]> {
    const ref = repoRef(await this.pushRepoUrl())
    if (ref === null) return []
    const query = `ref=${encodeURIComponent(`refs/heads/${branch}`)}&rule_suite_result=fail&per_page=10`
    const list = await this.exec(
      ["gh", "api", "--hostname", ref.host, `repos/${ref.slug}/rulesets/rule-suites?${query}`],
      this.directory,
    )
    if (list.exitCode !== 0) return []
    const suites = RuleSuiteListSchema.parse(safeJson(list.stdout))
    const suite = suites.find((candidate) => candidate.after_sha === sha) ?? suites[0]
    if (suite === undefined) return []
    const detail = await this.exec(
      ["gh", "api", "--hostname", ref.host, `repos/${ref.slug}/rulesets/rule-suites/${suite.id}`],
      this.directory,
    )
    if (detail.exitCode !== 0) return []
    return RuleSuiteDetailSchema.parse(safeJson(detail.stdout))
      .rule_evaluations.filter((evaluation) => evaluation.result === "fail")
      .map((evaluation) => ({ ruleType: evaluation.rule_type, message: evaluation.details }))
  }

  async buildReport(target: PushTarget, maxLogLines: number): Promise<CiReport> {
    this.repoUrl = target.repoUrl
    const [runs, pr] = await Promise.all([
      this.listRuns(target.sha, target.branch),
      this.findPrForBranch(target.branch),
    ])
    const failed = runs.filter((run) => run.conclusion === "failure" || run.conclusion === "timed_out")
    const failedLogs = await Promise.all(failed.map((run) => this.failedLog(run, maxLogLines)))
    const ruleFailures =
      pr !== null && (pr.mergeStateStatus === "BLOCKED" || pr.mergeStateStatus === "UNSTABLE")
        ? await this.ruleSuiteFailures(target.branch, target.sha)
        : []
    return {
      sha: target.sha,
      branch: target.branch,
      repo: target.repo,
      sourceKind: target.sourceKind,
      directory: target.directory,
      runs,
      failedLogs,
      pr,
      ruleFailures,
    }
  }

  private async run(argv: readonly string[]): Promise<ExecResult> {
    const result = await this.exec(argv, this.directory)
    if (result.exitCode !== 0) {
      throw new GhError(argv, result.exitCode, result.stderr)
    }
    return result
  }
}
