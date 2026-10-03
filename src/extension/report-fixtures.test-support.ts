import type { Locale } from "../i18n.ts"
import { renderPromptReport } from "../render.ts"
import { renderMidCiReviewUpdate, renderPostCiReviewUpdate, renderReviewEnded } from "../render-review.ts"
import type {
  CiReport,
  CommitSha,
  PrInfo,
  ReviewComment,
  ReviewDelta,
  ReviewSnapshot,
  WorkflowRun,
} from "../types.ts"

const MARKER = "_🤖 via agent_"
const CTX = { repo: "github.com/o/r", prNumber: 12 }

const run = (
  id: number,
  status: WorkflowRun["status"],
  conclusion: WorkflowRun["conclusion"],
): WorkflowRun => ({
  id,
  name: "ci",
  workflowName: "CI",
  status,
  conclusion,
  url: `https://github.com/o/r/actions/runs/${id}`,
  branch: "main",
})

const pr: PrInfo = {
  number: 12,
  title: "feat: [ci-loop] lookalike title",
  url: "https://github.com/o/r/pull/12",
  isDraft: true,
  state: "OPEN",
  mergeable: "MERGEABLE",
  mergeStateStatus: "BLOCKED",
  reviewDecision: "CHANGES_REQUESTED",
  commitCount: 3,
  checks: [],
}

const comment: ReviewComment = {
  databaseId: 1,
  author: "alice",
  body: "please rename",
  path: "src/app.ts",
  line: 5,
  url: "https://github.com/o/r/pull/12#discussion_r1",
  createdAt: "2026-07-24T10:00:00Z",
  updatedAt: "2026-07-24T10:00:00Z",
}

const snapshot: ReviewSnapshot = {
  prNumber: 12,
  prState: "OPEN",
  merged: false,
  reviewDecision: "CHANGES_REQUESTED",
  mergeStateStatus: "BLOCKED",
  threads: [{ id: "T1", isResolved: false, isOutdated: false, comments: [comment] }],
  reviews: [],
  comments: [],
  fetchedAt: 0,
}

const delta: ReviewDelta = {
  newComments: [{ comment, threadId: "T1", isResolved: false, path: comment.path, line: comment.line }],
  newReviews: [],
  threadsResolved: [],
  threadsUnresolved: [],
  decisionChange: null,
  mergeStateChange: null,
  unresolved: { from: 0, to: 1 },
}

const failedReport: CiReport = {
  sha: "abcdef1234567890" as CommitSha,
  branch: "main",
  repo: CTX.repo,
  sourceKind: "session",
  directory: "/repo",
  runs: [run(1, "completed", "failure")],
  failedLogs: [{ runName: "CI", runId: 1, logTail: "error: boom" }],
  pr,
  ruleFailures: [],
  review: snapshot,
}

const greenReport: CiReport = {
  ...failedReport,
  runs: [run(1, "completed", "success")],
  failedLogs: [],
  pr: null,
  review: null,
}

/** Every text the plugin injects as a session prompt, produced by the real renderers. */
export function injectedReports(locale: Locale): Readonly<Record<string, string>> {
  return {
    failedCi: renderPromptReport(failedReport, locale, MARKER),
    greenCi: renderPromptReport(greenReport, locale, MARKER),
    midCiReview: renderMidCiReviewUpdate(
      { delta, snapshot, runs: [run(1, "completed", "success"), run(2, "in_progress", null)] },
      CTX,
      MARKER,
      locale,
    ),
    postCiReview: renderPostCiReviewUpdate(
      delta,
      snapshot,
      { ready: false, blockers: ["x"] },
      CTX,
      MARKER,
      locale,
    ),
    reviewEnded: renderReviewEnded(
      {
        snapshot: { ...snapshot, threads: [] },
        delta: { ...delta, unresolved: { from: 1, to: 0 } },
        reason: "ready",
      },
      CTX,
      locale,
    ),
  }
}
