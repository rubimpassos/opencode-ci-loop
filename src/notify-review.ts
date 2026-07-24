import type { Messages } from "./i18n.ts"
import { isBotAuthor } from "./review.ts"
import type { ReviewDelta, SessionId } from "./types.ts"

/** Review fingerprints are keyed by repo+PR (not sha) so they survive new pushes to the branch. */
export const reviewKey = (sessionID: SessionId, repo: string, prNumber: number): string =>
  `${sessionID}\0${repo}\0pr${prNumber}`

export type UnseenDelta = { readonly delta: ReviewDelta; readonly fingerprints: readonly string[] }

/** Filters a delta to the items whose lock-§9 fingerprints are not in `seen` yet. */
export function filterUnseen(delta: ReviewDelta, base: string, seen: ReadonlySet<string>): UnseenDelta {
  const fingerprints: string[] = []
  const keep = (suffix: string): boolean => {
    const fingerprint = `${base}\0${suffix}`
    if (seen.has(fingerprint)) return false
    fingerprints.push(fingerprint)
    return true
  }
  const unseen: ReviewDelta = {
    newComments: delta.newComments.filter((event) =>
      keep(`comment:${event.comment.databaseId}:${event.comment.updatedAt}`),
    ),
    newReviews: delta.newReviews.filter((review) => keep(`review:${review.databaseId}`)),
    threadsResolved: delta.threadsResolved.filter((thread) =>
      keep(`thread:${thread.threadId}:resolved:true`),
    ),
    threadsUnresolved: delta.threadsUnresolved.filter((thread) =>
      keep(`thread:${thread.threadId}:resolved:false`),
    ),
    decisionChange:
      delta.decisionChange && keep(`decision:${delta.decisionChange.from}->${delta.decisionChange.to}`)
        ? delta.decisionChange
        : null,
    mergeStateChange:
      delta.mergeStateChange &&
      keep(`mergestate:${delta.mergeStateChange.from}->${delta.mergeStateChange.to}`)
        ? delta.mergeStateChange
        : null,
    unresolved: delta.unresolved,
  }
  return { delta: unseen, fingerprints }
}

/** Technical, non-localized delta digest for the generic review-update toast. */
function deltaSummary(delta: ReviewDelta): string {
  const parts: string[] = []
  if (delta.newComments.length > 0) parts.push(`+${delta.newComments.length} comments`)
  if (delta.newReviews.length > 0) parts.push(`+${delta.newReviews.length} reviews`)
  if (delta.threadsResolved.length > 0) parts.push(`${delta.threadsResolved.length} resolved`)
  if (delta.threadsUnresolved.length > 0) parts.push(`${delta.threadsUnresolved.length} reopened`)
  if (delta.decisionChange !== null) {
    parts.push(`${delta.decisionChange.from ?? "—"} → ${delta.decisionChange.to ?? "—"}`)
  }
  if (delta.mergeStateChange !== null) {
    parts.push(`${delta.mergeStateChange.from} → ${delta.mergeStateChange.to}`)
  }
  return parts.join(", ")
}

/** Copilot-only comments → Copilot toast; one human comment → personal toast; anything else → digest. */
export function reviewUpdateToast(messages: Messages, delta: ReviewDelta, prNumber: number): string {
  const comments = delta.newComments
  const allBots =
    comments.length > 0 &&
    comments.every((event) => isBotAuthor(event.comment.author)) &&
    delta.newReviews.every((review) => isBotAuthor(review.author))
  if (allBots) return messages.toastCopilotReview(comments.length, prNumber)
  const single = comments.length === 1 && delta.newReviews.length === 0 ? comments[0] : undefined
  if (single !== undefined && !isBotAuthor(single.comment.author)) {
    return messages.toastNewComment(single.comment.author, prNumber)
  }
  return messages.toastReviewUpdate(deltaSummary(delta), prNumber)
}
