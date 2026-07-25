import { CATALOGS, type Locale, type Messages, resolveLocale } from "./i18n.ts"
import { buildChrome, panelLocale } from "./panel-locale.ts"
import type {
  PanelCheck,
  PanelFailure,
  PanelPhaseKey,
  PanelPr,
  PanelRun,
  PanelSession,
  PanelSnapshot,
  PanelTone,
  PanelWatch,
} from "./panel-types.ts"
import { externalChecks, isReportClean, prReadiness, sourceLabel } from "./render.ts"
import { unresolvedThreadCount } from "./render-review.ts"
import {
  assertNever,
  type CiReport,
  type FailedRunLog,
  type PrInfo,
  type ReviewSnapshot,
  type SessionId,
  type SessionState,
  type Watch,
  type WatchPhase,
  type WorkflowRun,
} from "./types.ts"

export { buildChrome, panelLocale }

export type PanelDeps = {
  readonly language: string
  readonly locales: ReadonlyMap<SessionId, Locale>
  readonly titles: ReadonlyMap<SessionId, string>
}

/** Projects the frozen watch state into the localized, fully-resolved view model the panel renders. */
export function buildPanelSnapshot(sessions: readonly SessionState[], deps: PanelDeps): PanelSnapshot {
  return {
    chrome: buildChrome(CATALOGS[panelLocale(deps.language, sessions, deps.locales)]),
    sessions: sessions.map((session) => buildSession(session, deps)),
  }
}

/** Per-session strings follow that session's locale — a multi-project panel renders several at once. */
function buildSession(session: SessionState, deps: PanelDeps): PanelSession {
  const locale = resolveLocale(deps.language, deps.locales.get(session.sessionID))
  const title = deps.titles.get(session.sessionID) ?? null
  const identity: readonly (string | null)[] = [title, session.sessionID, session.directory]
  return {
    sessionID: session.sessionID,
    title,
    projectLabel: basename(session.directory),
    directory: session.directory,
    enabled: session.enabled,
    watches: session.watches.map((watch) => buildWatch(watch, locale, identity)),
    searchText: haystack(identity),
  }
}

function buildWatch(watch: Watch, locale: Locale, identity: readonly (string | null)[]): PanelWatch {
  const content = contentOf(watch.phase)
  const phase = phaseOf(watch.phase, CATALOGS[locale])
  const pr = prOf(content, locale)
  return {
    key: `${watch.repo}\0${watch.branch}`,
    meta: `${watch.repo} · ${watch.branch} · ${sourceLabel(watch.sourceKind, watch.directory)} · ${watch.sha.slice(0, 8)}`,
    phaseKey: phase.key,
    tone: toneOf(phase.key),
    phaseLabel: phase.label,
    runs: content.runs.map(runRow),
    checks: checksOf(content.report),
    failures: content.report?.failedLogs.map(failureRow) ?? [],
    pr,
    searchText: haystack([...identity, watch.repo, watch.branch, pr && `#${pr.number}`, pr?.title ?? null]),
  }
}

type PhaseContent = {
  readonly report: CiReport | null
  readonly runs: readonly WorkflowRun[]
  /** Fresher review state; set only while the review loop owns the watch (see `prOf`). */
  readonly fresh: ReviewSnapshot | null
}

const NO_CONTENT: PhaseContent = { report: null, runs: [], fresh: null }

function contentOf(phase: WatchPhase): PhaseContent {
  switch (phase.kind) {
    case "waiting":
    case "error":
      return NO_CONTENT
    case "running":
    case "timed-out":
      return { report: null, runs: phase.runs, fresh: null }
    case "done":
      return { report: phase.report, runs: phase.report.runs, fresh: null }
    case "reviewing":
    case "review-ended":
      return { report: phase.report, runs: phase.report.runs, fresh: phase.snapshot }
    default:
      return assertNever(phase)
  }
}

function phaseOf(
  phase: WatchPhase,
  messages: Messages,
): { readonly key: PanelPhaseKey; readonly label: string } {
  switch (phase.kind) {
    case "waiting":
      return { key: "waiting", label: messages.panelPhaseWaiting }
    case "running":
      return { key: "running", label: messages.panelPhaseRunning }
    case "done":
      return isReportClean(phase.report)
        ? { key: "done-green", label: messages.panelPhaseCiGreen }
        : { key: "done-failed", label: messages.panelPhaseCiFailed }
    case "reviewing":
      return {
        key: "reviewing",
        label: messages.panelWatchingReviews(unresolvedThreadCount(phase.snapshot)),
      }
    case "review-ended":
      return { key: "review-ended", label: messages.panelReviewEnded(phase.reason) }
    case "timed-out":
      return { key: "timed-out", label: messages.panelPhaseTimedOut }
    case "error":
      return { key: "error", label: messages.panelPhaseError(phase.message) }
    default:
      return assertNever(phase)
  }
}

function toneOf(key: PanelPhaseKey): PanelTone {
  switch (key) {
    case "waiting":
    case "running":
    case "reviewing":
      return "info"
    case "done-green":
    case "review-ended":
      return "ok"
    case "done-failed":
    case "error":
      return "fail"
    case "timed-out":
      return "warn"
    default:
      return assertNever(key)
  }
}

/**
 * Freshness rule: while the review loop owns the watch, `report.pr` is stale — the injected review
 * updates already told the user the snapshot's `mergeStateStatus`/`reviewDecision`, so the panel must
 * agree with what was last read. For `done`, the report's own review snapshot supplies the unresolved
 * count. Readiness itself is never reimplemented here: `prReadiness` is the single engine.
 */
function prOf(content: PhaseContent, locale: Locale): PanelPr | null {
  const report = content.report
  if (report === null || report.pr === null) return null
  const fresh = content.fresh
  const pr: PrInfo =
    fresh === null
      ? report.pr
      : { ...report.pr, mergeStateStatus: fresh.mergeStateStatus, reviewDecision: fresh.reviewDecision }
  const review = fresh ?? report.review
  const unresolved = review === null ? 0 : unresolvedThreadCount(review)
  const messages = CATALOGS[locale]
  const readiness = prReadiness(pr, isReportClean(report), unresolved, locale)
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    ready: readiness.ready,
    verdictLabel: readiness.ready ? messages.readyToMerge : messages.notReadyToMerge,
    blockers: readiness.blockers,
    draftLabel: pr.isDraft ? messages.panelDraft : null,
  }
}

function checksOf(report: CiReport | null): readonly PanelCheck[] {
  if (report === null) return []
  return externalChecks(report).map((check) => ({
    name: check.name,
    url: check.url,
    state: check.state,
    failing: check.status === "failing",
  }))
}

function runRow(run: WorkflowRun): PanelRun {
  return { name: run.workflowName, url: run.url, status: run.status, state: run.conclusion ?? run.status }
}

function failureRow(log: FailedRunLog): PanelFailure {
  return { runName: log.runName, logTail: log.logTail }
}

/** Lowercased search haystack. Values pass through RAW — escaping belongs to the client. */
function haystack(parts: readonly (string | null)[]): string {
  return parts
    .filter((part): part is string => part !== null && part !== "")
    .join(" ")
    .toLowerCase()
}

function basename(directory: string | null): string | null {
  return (
    (directory ?? "")
      .split("/")
      .filter((part) => part !== "")
      .at(-1) ?? null
  )
}
