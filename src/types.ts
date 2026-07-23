import { z } from "zod"

declare const brand: unique symbol
type Brand<T, B extends string> = T & { readonly [brand]: B }

export type SessionId = Brand<string, "SessionId">
export type CommitSha = Brand<string, "CommitSha">
export type WatchKey = Brand<string, "WatchKey">

export const WATCH_SOURCE_KINDS = ["session", "linked-worktree", "external-repo", "unknown"] as const
export type WatchSourceKind = (typeof WATCH_SOURCE_KINDS)[number]

export type PushTarget = {
  readonly sha: CommitSha
  readonly branch: string
  readonly repo: string
  readonly repoUrl: string
  readonly directory: string | null
  readonly sourceKind: WatchSourceKind
}

export const RUN_STATUSES = ["queued", "in_progress", "completed"] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

export const RUN_CONCLUSIONS = [
  "success",
  "failure",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
  "neutral",
  "startup_failure",
  "stale",
] as const
export type RunConclusion = (typeof RUN_CONCLUSIONS)[number]

export type WorkflowRun = {
  readonly id: number
  readonly name: string
  readonly workflowName: string
  readonly status: RunStatus
  readonly conclusion: RunConclusion | null
  readonly url: string
  readonly branch: string
}

export type FailedRunLog = {
  readonly runId: number
  readonly runName: string
  readonly logTail: string
}

export const PR_STATES = ["OPEN", "CLOSED", "MERGED"] as const
export type PrState = (typeof PR_STATES)[number]

export const PR_MERGEABLE_STATES = ["MERGEABLE", "CONFLICTING", "UNKNOWN"] as const
export type PrMergeable = (typeof PR_MERGEABLE_STATES)[number]

export const PR_MERGE_STATE_STATUSES = [
  "BEHIND",
  "BLOCKED",
  "CLEAN",
  "DIRTY",
  "DRAFT",
  "HAS_HOOKS",
  "UNKNOWN",
  "UNSTABLE",
] as const
export type PrMergeStateStatus = (typeof PR_MERGE_STATE_STATUSES)[number]

export const PR_REVIEW_DECISIONS = ["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"] as const
export type PrReviewDecision = (typeof PR_REVIEW_DECISIONS)[number]

export const PR_CHECK_STATUSES = ["passing", "failing", "pending", "skipped"] as const
export type PrCheckStatus = (typeof PR_CHECK_STATUSES)[number]

/** Normalized entry of the PR statusCheckRollup (covers non-Actions checks: apps, commit statuses). */
export type PrCheck = {
  readonly name: string
  /** Workflow name for GitHub Actions check runs; null for external apps / status contexts. */
  readonly workflowName: string | null
  readonly status: PrCheckStatus
  /** Raw GraphQL state/conclusion (e.g. "FAILURE", "PENDING") for display. */
  readonly state: string
  readonly url: string | null
}

/** A failed rule evaluation from the GitHub rulesets rule-suites API (names the exact blocking rule). */
export type RuleFailure = {
  readonly ruleType: string
  readonly message: string | null
}

export type PrInfo = {
  readonly number: number
  readonly title: string
  readonly url: string
  readonly isDraft: boolean
  readonly state: PrState
  readonly mergeable: PrMergeable
  readonly mergeStateStatus: PrMergeStateStatus
  readonly reviewDecision: PrReviewDecision | null
  /** Total commits in the PR (REST); null when the lookup fails. GitHub caps rebase merges at 100. */
  readonly commitCount: number | null
  readonly checks: readonly PrCheck[]
}

export type CiReport = {
  readonly sha: CommitSha
  readonly branch: string
  readonly repo: string
  readonly sourceKind: WatchSourceKind
  readonly directory: string | null
  readonly runs: readonly WorkflowRun[]
  readonly failedLogs: readonly FailedRunLog[]
  readonly pr: PrInfo | null
  readonly ruleFailures: readonly RuleFailure[]
}

export type WatchPhase =
  | { readonly kind: "waiting" }
  | { readonly kind: "running"; readonly runs: readonly WorkflowRun[] }
  | { readonly kind: "done"; readonly report: CiReport }
  | { readonly kind: "timed-out"; readonly runs: readonly WorkflowRun[] }
  | { readonly kind: "error"; readonly message: string }

export type Watch = {
  readonly sha: CommitSha
  readonly branch: string
  readonly repo: string
  readonly repoUrl: string
  readonly directory: string | null
  readonly sourceKind: WatchSourceKind
  readonly startedAt: number
  readonly phase: WatchPhase
}

export type SessionState = {
  readonly sessionID: SessionId
  readonly enabled: boolean
  readonly watches: readonly Watch[]
  /** @deprecated Compatibility alias for the most recently started watch. */
  readonly watch: Watch | null
  /** Directory of the project that claimed the session; null until an instance-scoped path provides it (never undone afterward). */
  readonly directory: string | null
}

export const PluginConfigSchema = z.object({
  autoWatch: z.boolean().default(true),
  pollIntervalMs: z.number().int().min(1000).default(15_000),
  initialDelayMs: z.number().int().min(0).default(5_000),
  timeoutMs: z
    .number()
    .int()
    .min(10_000)
    .default(30 * 60_000),
  failLogLines: z.number().int().min(10).max(500).default(80),
  dashboard: z
    .object({
      enabled: z.boolean().default(true),
      host: z.string().default("127.0.0.1"),
      port: z.number().int().min(1024).max(65535).default(4517),
    })
    .default({ enabled: true, host: "127.0.0.1", port: 4517 }),
})

export type PluginConfig = z.infer<typeof PluginConfigSchema>

export function assertNever(value: never): never {
  throw new Error(`Unexpected variant: ${JSON.stringify(value)}`)
}
