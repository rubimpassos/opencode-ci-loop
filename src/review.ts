import type {
  NewCommentEvent,
  ReviewDelta,
  ReviewEndReason,
  ReviewInfo,
  ReviewSnapshot,
  ReviewThread,
  ThreadChange,
} from "./types.ts"

export type ReviewCycleOutcome =
  | { readonly kind: "continue" }
  | { readonly kind: "notify"; readonly delta: ReviewDelta }
  | { readonly kind: "end"; readonly reason: ReviewEndReason; readonly delta: ReviewDelta }

type DeltaOptions = {
  readonly agentMarker: string
  readonly ignoreAuthors: readonly string[]
}

/** Threads still awaiting resolution; the review loop's core progress metric. */
export function unresolvedCount(snapshot: ReviewSnapshot | null): number {
  if (snapshot === null) return 0
  return snapshot.threads.filter((thread) => !thread.isResolved).length
}

/** Display-only bot detection (🤖 vs 👤) — never used for filtering (plan lock §13). */
export function isBotAuthor(login: string): boolean {
  return login === "Copilot" || login === "copilot-pull-request-reviewer" || login.endsWith("[bot]")
}

function lastNonEmptyLine(body: string): string {
  const lines = body.split("\n")
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = (lines[index] ?? "").trim()
    if (line.length > 0) return line
  }
  return ""
}

/** The ONLY two notification filters (plan lock §14): agent marker on the last non-empty line, exact ignoreAuthors login. */
function isExcluded(author: string, body: string, options: DeltaOptions): boolean {
  if (options.ignoreAuthors.includes(author)) return true
  return options.agentMarker.length > 0 && lastNonEmptyLine(body).includes(options.agentMarker)
}

function collectCommentIds(snapshot: ReviewSnapshot): Set<number> {
  const ids = new Set<number>()
  for (const thread of snapshot.threads) {
    for (const item of thread.comments) ids.add(item.databaseId)
  }
  for (const item of snapshot.comments) ids.add(item.databaseId)
  return ids
}

function collectNewComments(
  prev: ReviewSnapshot,
  curr: ReviewSnapshot,
  options: DeltaOptions,
): NewCommentEvent[] {
  const known = collectCommentIds(prev)
  const events: NewCommentEvent[] = []
  for (const thread of curr.threads) {
    for (const item of thread.comments) {
      if (known.has(item.databaseId) || isExcluded(item.author, item.body, options)) continue
      events.push({
        comment: item,
        threadId: thread.id,
        isResolved: thread.isResolved,
        path: item.path,
        line: item.line,
      })
    }
  }
  for (const item of curr.comments) {
    if (known.has(item.databaseId) || isExcluded(item.author, item.body, options)) continue
    events.push({ comment: item, threadId: null, isResolved: null, path: item.path, line: item.line })
  }
  return events
}

function collectNewReviews(prev: ReviewSnapshot, curr: ReviewSnapshot, options: DeltaOptions): ReviewInfo[] {
  const known = new Set(prev.reviews.map((item) => item.databaseId))
  return curr.reviews.filter(
    (item) => !known.has(item.databaseId) && !isExcluded(item.author, item.body, options),
  )
}

function toThreadChange(thread: ReviewThread): ThreadChange {
  const first = thread.comments[0]
  return { threadId: thread.id, path: first?.path ?? null, line: first?.line ?? null }
}

function collectThreadFlips(
  prev: ReviewSnapshot,
  curr: ReviewSnapshot,
): { readonly resolved: readonly ThreadChange[]; readonly unresolved: readonly ThreadChange[] } {
  const prevById = new Map(prev.threads.map((thread) => [thread.id, thread]))
  const resolved: ThreadChange[] = []
  const unresolved: ThreadChange[] = []
  for (const thread of curr.threads) {
    const before = prevById.get(thread.id)
    if (before === undefined || before.isResolved === thread.isResolved) continue
    if (thread.isResolved) resolved.push(toThreadChange(thread))
    else unresolved.push(toThreadChange(thread))
  }
  return { resolved, unresolved }
}

/**
 * Pure id-based diff between two review snapshots. `prev === null` seeds the
 * baseline: everything already present is considered seen, so the delta is empty.
 */
export function computeDelta(
  prev: ReviewSnapshot | null,
  curr: ReviewSnapshot,
  options: DeltaOptions,
): ReviewDelta {
  if (prev === null) {
    const count = unresolvedCount(curr)
    return {
      newComments: [],
      newReviews: [],
      threadsResolved: [],
      threadsUnresolved: [],
      decisionChange: null,
      mergeStateChange: null,
      unresolved: { from: count, to: count },
    }
  }
  const flips = collectThreadFlips(prev, curr)
  return {
    newComments: collectNewComments(prev, curr, options),
    newReviews: collectNewReviews(prev, curr, options),
    threadsResolved: flips.resolved,
    threadsUnresolved: flips.unresolved,
    decisionChange:
      prev.reviewDecision === curr.reviewDecision
        ? null
        : { from: prev.reviewDecision, to: curr.reviewDecision },
    mergeStateChange:
      prev.mergeStateStatus === curr.mergeStateStatus
        ? null
        : { from: prev.mergeStateStatus, to: curr.mergeStateStatus },
    unresolved: { from: unresolvedCount(prev), to: unresolvedCount(curr) },
  }
}

export function isEmptyDelta(delta: ReviewDelta): boolean {
  return (
    delta.newComments.length === 0 &&
    delta.newReviews.length === 0 &&
    delta.threadsResolved.length === 0 &&
    delta.threadsUnresolved.length === 0 &&
    delta.decisionChange === null &&
    delta.mergeStateChange === null &&
    delta.unresolved.from === delta.unresolved.to
  )
}

/** Review-loop decision logic per plan lock §7 — rule order is part of the contract. */
export function evaluateReviewCycle(input: {
  readonly delta: ReviewDelta
  readonly snapshot: ReviewSnapshot
  readonly nowMs: number
  readonly idleDeadline: number
}): ReviewCycleOutcome {
  const { delta, snapshot, nowMs, idleDeadline } = input
  if (snapshot.merged) return { kind: "end", reason: "merged", delta }
  if (snapshot.prState !== "OPEN") return { kind: "end", reason: "closed", delta }
  if (nowMs >= idleDeadline) return { kind: "end", reason: "idle-timeout", delta }
  if (isEmptyDelta(delta)) return { kind: "continue" }
  const resolvedToZero = delta.unresolved.to === 0 && delta.unresolved.from > 0
  const decisionAllowsMerge = snapshot.reviewDecision === "APPROVED" || snapshot.reviewDecision === null
  if (resolvedToZero && decisionAllowsMerge && snapshot.mergeStateStatus === "CLEAN") {
    return { kind: "end", reason: "ready", delta }
  }
  return { kind: "notify", delta }
}
