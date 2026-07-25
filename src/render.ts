import { CATALOGS, type Locale } from "./i18n.ts"
import { renderMarkerInstruction, renderReviewSection } from "./render-review.ts"
import {
  assertNever,
  type CiReport,
  type PrCheck,
  type PrInfo,
  type PushTarget,
  type WatchSourceKind,
  type WorkflowRun,
} from "./types.ts"

export function runIcon(run: WorkflowRun): string {
  switch (run.status) {
    case "queued":
      return "⏳"
    case "in_progress":
      return "🔄"
    case "completed":
      return run.conclusion === "success" ? "✅" : run.conclusion === "skipped" ? "⏭️" : "❌"
    default:
      return assertNever(run.status)
  }
}

export function summarizeRuns(runs: readonly WorkflowRun[]): string {
  const total = runs.length
  const completed = runs.filter((run) => run.status === "completed")
  const failing = completed.filter(
    (run) => run.conclusion !== "success" && run.conclusion !== "skipped",
  ).length
  const passing = completed.length - failing
  if (completed.length === total) {
    return failing === 0 ? `${passing}/${total} passing` : `${failing}/${total} failing`
  }
  return `${completed.length}/${total} completed${failing > 0 ? ` (${failing} failing)` : ""}`
}

export function isReportClean(report: CiReport): boolean {
  return report.runs.every((run) => run.conclusion === "success" || run.conclusion === "skipped")
}

/** Failing/pending PR checks not already listed as a workflow run — shared by the report and the panel. */
export function externalChecks(report: CiReport): readonly PrCheck[] {
  const runWorkflows = new Set(report.runs.map((run) => run.workflowName))
  return (report.pr?.checks ?? []).filter(
    (check) =>
      (check.status === "failing" || check.status === "pending") &&
      (check.workflowName === null || !runWorkflows.has(check.workflowName)),
  )
}

const REBASE_MERGE_COMMIT_LIMIT = 100

/** Matches the `review.agentMarker` config default; T9 threads the configured value through. */
const DEFAULT_AGENT_MARKER = "_🤖 via agent_"

export function prReadiness(
  pr: PrInfo,
  ciClean: boolean,
  unresolvedCount = 0,
  locale: Locale = "en",
): { readonly ready: boolean; readonly blockers: readonly string[]; readonly warnings: readonly string[] } {
  const messages = CATALOGS[locale]
  const blockers: string[] = []
  const warnings: string[] = []
  let mergeabilityPending = false

  if (pr.commitCount !== null && pr.commitCount > REBASE_MERGE_COMMIT_LIMIT) {
    warnings.push(messages.rebaseWarning(pr.commitCount, REBASE_MERGE_COMMIT_LIMIT))
  }

  if (pr.isDraft) blockers.push(messages.blockerDraft)

  switch (pr.mergeable) {
    case "MERGEABLE":
      break
    case "CONFLICTING":
      blockers.push(messages.blockerConflicts)
      break
    case "UNKNOWN":
      mergeabilityPending = true
      break
    default:
      assertNever(pr.mergeable)
  }

  switch (pr.mergeStateStatus) {
    case "CLEAN":
      break
    case "BEHIND":
      blockers.push(messages.blockerBehind)
      break
    case "BLOCKED":
      blockers.push(messages.blockerBranchProtection)
      break
    case "DIRTY":
      if (!blockers.includes(messages.blockerConflicts)) {
        blockers.push(messages.blockerConflicts)
      }
      break
    case "DRAFT":
      if (!blockers.includes(messages.blockerDraft)) blockers.push(messages.blockerDraft)
      break
    case "HAS_HOOKS":
      blockers.push(messages.blockerMergeHooks)
      break
    case "UNSTABLE":
      blockers.push(messages.blockerChecksUnstable)
      break
    case "UNKNOWN":
      mergeabilityPending = true
      break
    default:
      assertNever(pr.mergeStateStatus)
  }

  switch (pr.reviewDecision) {
    case "APPROVED":
    case null:
      break
    case "CHANGES_REQUESTED":
      blockers.push(messages.blockerChangesRequested)
      break
    case "REVIEW_REQUIRED":
      blockers.push(messages.blockerReviewRequired)
      break
    default:
      assertNever(pr.reviewDecision)
  }

  if (unresolvedCount > 0) blockers.push(messages.blockerUnresolvedConversations(unresolvedCount))
  if (!ciClean) blockers.push(messages.blockerCiFailing)
  if (mergeabilityPending && blockers.length === 0) {
    blockers.push(messages.blockerMergeabilityPending)
  }
  return { ready: blockers.length === 0, blockers, warnings }
}

/** Notice appended to `git push` output to stop manual CI polling (the result is injected on its own). */
export function renderWatchNotice(targets: readonly PushTarget[]): string {
  return [
    "",
    "",
    "[ci-loop] CI watch started automatically for:",
    ...targets.map(
      (target) =>
        `- ${target.repo} · ${target.branch} @ \`${target.sha.slice(0, 8)}\` — ${sourceLabel(target.sourceKind, target.directory)}`,
    ),
    "Do NOT wait for or manually poll CI — no `sleep`, `gh pr checks`, `gh run watch` or equivalent.",
    "The result (green or with failure logs) will be injected into THIS session automatically when CI finishes.",
    "Move on to other work or end your turn; you'll be pinged when there's a result.",
  ].join("\n")
}

/** Markdown report injected as a synthetic prompt into the session (template B when `report.review` is set). */
export function renderPromptReport(
  report: CiReport,
  locale: Locale = "en",
  marker: string = DEFAULT_AGENT_MARKER,
): string {
  const messages = CATALOGS[locale]
  const ciClean = isReportClean(report)
  const review = report.review === null ? null : renderReviewSection(report.review, locale)
  const lines: string[] = [
    messages.ciResultHeader(report.repo, report.branch, report.sha.slice(0, 8)),
    messages.sourceLine(sourceLabel(report.sourceKind, report.directory)),
    "",
  ]
  for (const run of report.runs) {
    lines.push(`- ${runIcon(run)} **${run.workflowName}** — ${run.conclusion ?? run.status} (${run.url})`)
  }

  const checks = externalChecks(report)
  if (checks.length > 0) {
    lines.push("", messages.otherChecksHeader)
    for (const check of checks) {
      const icon = check.status === "failing" ? "❌" : "⏳"
      lines.push(`- ${icon} **${check.name}** — ${check.state}${check.url ? ` (${check.url})` : ""}`)
    }
  }

  const readiness = report.pr ? prReadiness(report.pr, ciClean, review?.unresolvedCount ?? 0, locale) : null
  if (report.pr && readiness) {
    lines.push(
      "",
      messages.pullRequestSection,
      "",
      `**#${report.pr.number} — ${report.pr.title}** (${report.pr.url})`,
      messages.draftLine(report.pr.isDraft),
      "",
    )
    if (readiness.ready) {
      lines.push(messages.readyToMerge)
    } else {
      lines.push(messages.notReadyToMerge, ...readiness.blockers.map((blocker) => `- ${blocker}`))
    }
    if (report.ruleFailures.length > 0) {
      lines.push(
        "",
        messages.failingRulesHeader,
        ...report.ruleFailures.map(
          (rule) => `- \`${rule.ruleType}\`${rule.message ? ` — ${rule.message}` : ""}`,
        ),
      )
    }
    lines.push(...readiness.warnings.map((warning) => `⚠️ ${warning}`))
  }

  if (review !== null) lines.push("", ...review.lines)

  if (ciClean) {
    if (readiness?.ready) {
      lines.push("", messages.allPassedPrReady)
    } else if (report.pr) {
      lines.push("", messages.ciPassedReviewBlockers)
    } else {
      lines.push("", messages.allPassedNoPr)
    }
  } else {
    lines.push(
      "",
      messages.failureLogsSection,
      "",
      messages.failureLogsPreamble1,
      messages.failureLogsPreamble2,
    )
    for (const failed of report.failedLogs) {
      lines.push("", `### ${failed.runName} (run ${failed.runId})`, "```", failed.logTail.trim(), "```")
    }
    lines.push("", messages.fixInstruction1, messages.fixInstruction2)
  }

  if (review !== null) {
    lines.push("", messages.reviewKeepsWatching, "", ...renderMarkerInstruction(marker, locale))
  }
  return lines.join("\n")
}

export function sourceLabel(sourceKind: WatchSourceKind, directory: string | null): string {
  switch (sourceKind) {
    case "session":
      return "current branch of this session"
    case "linked-worktree":
      return `linked worktree at ${directory ?? "unknown directory"}`
    case "external-repo":
      return `external repo at ${directory ?? "unknown directory"}`
    case "unknown":
      return "source directory unknown"
    default:
      return assertNever(sourceKind)
  }
}
