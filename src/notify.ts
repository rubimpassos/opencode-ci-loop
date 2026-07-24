import { CATALOGS, type Locale, resolveLocale } from "./i18n.ts"
import { filterUnseen, reviewKey, reviewUpdateToast } from "./notify-review.ts"
import { watchKey } from "./registry.ts"
import { isReportClean, prReadiness, renderPromptReport, sourceLabel, summarizeRuns } from "./render.ts"
import { renderMidCiReviewUpdate, renderPostCiReviewUpdate, renderReviewEnded } from "./render-review.ts"
import { unresolvedCount } from "./review.ts"
import { type OpencodeClient, resolveSessionContext, type SessionModel } from "./session-context.ts"
import {
  assertNever,
  type MidCiReviewUpdate,
  type PluginConfig,
  type ReviewDelta,
  type SessionId,
  type Watch,
  type WatchPhase,
} from "./types.ts"

/** Everything a notification needs besides the event itself; assembled per call by plugin.ts. */
export type NotifyContext = {
  readonly client: OpencodeClient
  readonly notifications: Set<string>
  readonly locales: Map<SessionId, Locale>
  readonly config: PluginConfig
}

type CiPhase = Extract<WatchPhase, { kind: "waiting" | "running" | "done" | "timed-out" | "error" }>
type ReviewingPhase = Extract<WatchPhase, { kind: "reviewing" }>
type ReviewEndedPhase = Extract<WatchPhase, { kind: "review-ended" }>

/** Locale without a messages fetch (toast-only paths): explicit config or the cached detection. */
function cachedLocale(ctx: NotifyContext, sessionID: SessionId): Locale {
  return resolveLocale(ctx.config.language, ctx.locales.get(sessionID))
}

async function toast(
  ctx: NotifyContext,
  message: string,
  variant: "info" | "success" | "warning" | "error",
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return
  await ctx.client.tui.showToast({ body: { title: "CI Loop", message, variant } })
}

async function inject(
  ctx: NotifyContext,
  sessionID: SessionId,
  content: { readonly model?: SessionModel; readonly text: string },
): Promise<void> {
  await ctx.client.session.prompt({
    path: { id: sessionID },
    body: {
      ...(content.model && { model: content.model }),
      parts: [{ type: "text", text: content.text }],
    },
  })
}

export async function notifyPhase(
  ctx: NotifyContext,
  sessionID: SessionId,
  watch: Watch,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return
  const phase = watch.phase
  switch (phase.kind) {
    case "waiting":
    case "running":
    case "done":
    case "timed-out":
    case "error":
      return notifyCiPhase(ctx, sessionID, watch, phase, signal)
    case "reviewing":
      return notifyReviewing(ctx, sessionID, watch, phase, signal)
    case "review-ended":
      return notifyReviewEnded(ctx, sessionID, watch, phase, signal)
    default:
      return assertNever(phase)
  }
}

/** CI phases keep the pre-review phase-level fingerprint (session+watch+sha+phase) exactly as before. */
async function notifyCiPhase(
  ctx: NotifyContext,
  sessionID: SessionId,
  watch: Watch,
  phase: CiPhase,
  signal?: AbortSignal,
): Promise<void> {
  const phaseFingerprint = phase.kind === "running" ? `running:${summarizeRuns(phase.runs)}` : phase.kind
  const fingerprint = `${sessionID}\0${watchKey(watch.repo, watch.branch)}\0${watch.sha}\0${phaseFingerprint}`
  if (ctx.notifications.has(fingerprint)) return
  ctx.notifications.add(fingerprint)
  const context = `${watch.repo} · ${watch.branch} — ${sourceLabel(watch.sourceKind, watch.directory)}`
  const messages = CATALOGS[cachedLocale(ctx, sessionID)]

  switch (phase.kind) {
    case "waiting":
      return toast(ctx, messages.toastWaiting(context), "info", signal)
    case "running":
      return toast(ctx, messages.toastRunning(summarizeRuns(phase.runs), context), "info", signal)
    case "timed-out":
      return toast(ctx, messages.toastTimedOut(context), "warning", signal)
    case "error":
      return toast(ctx, messages.toastWatchError(phase.message, context), "error", signal)
    case "done": {
      const clean = isReportClean(phase.report)
      let message = clean ? messages.toastCiGreen(phase.report.runs.length) : messages.toastCiFailed
      if (phase.report.pr) {
        const readiness = prReadiness(phase.report.pr, clean)
        const prStatus = readiness.ready
          ? messages.toastPrReady
          : messages.toastPrBlocked(readiness.blockers.length)
        message += ` · PR #${phase.report.pr.number} ${prStatus}`
      }
      await toast(ctx, `${message} · ${context}`, clean ? "success" : "error", signal)
      if (signal?.aborted) return
      const session = await resolveSessionContext(ctx.client, sessionID, ctx.config.language, ctx.locales)
      if (signal?.aborted) return
      await inject(ctx, sessionID, {
        ...(session.model && { model: session.model }),
        text: renderPromptReport(phase.report, session.locale, ctx.config.review.agentMarker),
      })
      return
    }
    default:
      return assertNever(phase)
  }
}

type ReviewDeltaEvent = {
  readonly sessionID: SessionId
  readonly repo: string
  readonly prNumber: number
  readonly delta: ReviewDelta
  readonly render: (delta: ReviewDelta, locale: Locale) => string
}

/** Shared review-delta flow (post-CI and mid-CI): unseen filter → fingerprint → toast → one batched injection. */
async function notifyReviewDelta(
  ctx: NotifyContext,
  event: ReviewDeltaEvent,
  signal?: AbortSignal,
): Promise<void> {
  const base = reviewKey(event.sessionID, event.repo, event.prNumber)
  const unseen = filterUnseen(event.delta, base, ctx.notifications)
  if (unseen.fingerprints.length === 0) return
  for (const fingerprint of unseen.fingerprints) ctx.notifications.add(fingerprint)
  const session = await resolveSessionContext(ctx.client, event.sessionID, ctx.config.language, ctx.locales)
  if (signal?.aborted) return
  await toast(ctx, reviewUpdateToast(CATALOGS[session.locale], unseen.delta, event.prNumber), "info", signal)
  if (signal?.aborted) return
  await inject(ctx, event.sessionID, {
    ...(session.model && { model: session.model }),
    text: event.render(unseen.delta, session.locale),
  })
}

/** Post-CI review update (message C). */
function notifyReviewing(
  ctx: NotifyContext,
  sessionID: SessionId,
  watch: Watch,
  phase: ReviewingPhase,
  signal?: AbortSignal,
): Promise<void> {
  const prNumber = phase.snapshot.prNumber
  const render = (delta: ReviewDelta, locale: Locale): string => {
    const readiness = phase.report.pr
      ? prReadiness(phase.report.pr, isReportClean(phase.report), unresolvedCount(phase.snapshot), locale)
      : null
    return renderPostCiReviewUpdate(
      delta,
      phase.snapshot,
      readiness,
      { repo: watch.repo, prNumber },
      ctx.config.review.agentMarker,
      locale,
    )
  }
  return notifyReviewDelta(ctx, { sessionID, repo: watch.repo, prNumber, delta: phase.delta, render }, signal)
}

/** Mid-CI review update (message A): same unseen filtering + fingerprints as the reviewing phase. */
export async function notifyReviewUpdate(
  ctx: NotifyContext,
  sessionID: SessionId,
  watch: Watch,
  update: MidCiReviewUpdate,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return
  const prNumber = update.snapshot.prNumber
  const render = (delta: ReviewDelta, locale: Locale): string =>
    renderMidCiReviewUpdate(
      { ...update, delta },
      { repo: watch.repo, prNumber },
      ctx.config.review.agentMarker,
      locale,
    )
  return notifyReviewDelta(
    ctx,
    { sessionID, repo: watch.repo, prNumber, delta: update.delta, render },
    signal,
  )
}

/** End of the review watch: `ready` injects message D; every other reason is a quiet toast (lock §8). */
async function notifyReviewEnded(
  ctx: NotifyContext,
  sessionID: SessionId,
  watch: Watch,
  phase: ReviewEndedPhase,
  signal?: AbortSignal,
): Promise<void> {
  const prNumber = phase.snapshot.prNumber
  const fingerprint = `${reviewKey(sessionID, watch.repo, prNumber)}\0ended:${phase.reason}`
  if (ctx.notifications.has(fingerprint)) return
  ctx.notifications.add(fingerprint)
  const messages = CATALOGS[cachedLocale(ctx, sessionID)]
  switch (phase.reason) {
    case "ready": {
      const session = await resolveSessionContext(ctx.client, sessionID, ctx.config.language, ctx.locales)
      if (signal?.aborted) return
      await toast(ctx, CATALOGS[session.locale].toastAllResolved(prNumber), "success", signal)
      if (signal?.aborted) return
      const text = renderReviewEnded(
        { snapshot: phase.snapshot, delta: phase.delta, reason: "ready" },
        { repo: watch.repo, prNumber },
        session.locale,
      )
      await inject(ctx, sessionID, { ...(session.model && { model: session.model }), text })
      return
    }
    case "merged":
      return toast(ctx, messages.toastPrMerged(prNumber), "success", signal)
    case "closed":
      return toast(ctx, messages.toastPrClosed(prNumber), "info", signal)
    case "idle-timeout":
      return toast(ctx, messages.toastReviewIdle(prNumber), "info", signal)
    default:
      return assertNever(phase.reason)
  }
}

/** Every fingerprint (CI phase and review alike) starts with `${sessionID}\0`; the locale cache goes with them. */
export function clearSessionNotifications(
  notifications: Set<string>,
  sessionID: SessionId,
  locales: Map<SessionId, Locale>,
): void {
  const prefix = `${sessionID}\0`
  for (const fingerprint of notifications) {
    if (fingerprint.startsWith(prefix)) notifications.delete(fingerprint)
  }
  locales.delete(sessionID)
}
