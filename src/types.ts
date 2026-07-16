import { z } from "zod"

declare const brand: unique symbol
type Brand<T, B extends string> = T & { readonly [brand]: B }

export type SessionId = Brand<string, "SessionId">
export type CommitSha = Brand<string, "CommitSha">

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

export type CiReport = {
  readonly sha: CommitSha
  readonly branch: string
  readonly runs: readonly WorkflowRun[]
  readonly failedLogs: readonly FailedRunLog[]
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
  readonly startedAt: number
  readonly phase: WatchPhase
}

export type SessionState = {
  readonly sessionID: SessionId
  readonly enabled: boolean
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
