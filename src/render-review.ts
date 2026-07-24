import { CATALOGS, type Locale, type Messages } from "./i18n.ts"
import { isBotAuthor } from "./review.ts"
import type { MidCiReviewUpdate, NewCommentEvent, ReviewDelta, ReviewInfo, ReviewSnapshot } from "./types.ts"

export type ReviewMessageContext = { readonly repo: string; readonly prNumber: number }
export type ReviewReadiness = { readonly ready: boolean; readonly blockers: readonly string[] }

function displayAuthor(login: string): string {
  return login === "copilot-pull-request-reviewer" ? "Copilot" : login
}

function quoteBody(body: string): readonly string[] {
  return body.split("\n").map((line) => `> ${line}`)
}

function itemLocation(path: string | null, line: number | null, messages: Messages): string {
  if (path === null) return messages.prConversationContext
  return line === null ? path : `${path}:${line}`
}

type AuthorGroup = {
  readonly display: string
  readonly events: readonly NewCommentEvent[]
  readonly review: ReviewInfo | null
}

/** Groups delta entries by display author: bots first, then humans alphabetically (lock §13). */
function collectAuthorGroups(
  events: readonly NewCommentEvent[],
  reviews: readonly ReviewInfo[],
): readonly AuthorGroup[] {
  const byAuthor = new Map<string, { events: NewCommentEvent[]; review: ReviewInfo | null }>()
  const bucketOf = (display: string) => {
    const existing = byAuthor.get(display)
    if (existing) return existing
    const created = { events: [] as NewCommentEvent[], review: null as ReviewInfo | null }
    byAuthor.set(display, created)
    return created
  }
  for (const event of events) bucketOf(displayAuthor(event.comment.author)).events.push(event)
  for (const review of reviews) bucketOf(displayAuthor(review.author)).review = review
  return [...byAuthor.entries()]
    .map(([display, bucket]) => ({ display, events: bucket.events, review: bucket.review }))
    .sort((a, b) => {
      const botDiff = Number(isBotAuthor(b.display)) - Number(isBotAuthor(a.display))
      return botDiff !== 0 ? botDiff : a.display.localeCompare(b.display)
    })
}

function groupHeading(group: AuthorGroup, messages: Messages): string {
  const label = `${isBotAuthor(group.display) ? "🤖" : "👤"} **${group.display}**`
  return group.review ? messages.reviewGroupLine(label, group.review.state, group.events.length) : label
}

function decisionLine(delta: ReviewDelta, messages: Messages): string | null {
  if (delta.decisionChange === null) return null
  return messages.decisionChangeLine(delta.decisionChange.from ?? "—", delta.decisionChange.to ?? "—")
}

function mergeStateLine(delta: ReviewDelta, messages: Messages): string | null {
  if (delta.mergeStateChange === null) return null
  return messages.mergeStateChangeLine(delta.mergeStateChange.from, delta.mergeStateChange.to)
}

function statusChangeLines(delta: ReviewDelta, messages: Messages): readonly string[] {
  const unresolvedLine =
    delta.unresolved.from === delta.unresolved.to
      ? null
      : messages.unresolvedChangeLine(delta.unresolved.from, delta.unresolved.to)
  return [decisionLine(delta, messages), unresolvedLine, mergeStateLine(delta, messages)].filter(
    (line): line is string => line !== null,
  )
}

/** The 3-line marker instruction block terminating messages A/B/C. */
export function renderMarkerInstruction(marker: string, locale: Locale = "en"): readonly string[] {
  return CATALOGS[locale].markerInstruction(marker).split("\n")
}

/** Template A: review update injected while CI is still running. */
export function renderMidCiReviewUpdate(
  update: MidCiReviewUpdate,
  ctx: ReviewMessageContext,
  marker: string,
  locale: Locale = "en",
): string {
  const messages = CATALOGS[locale]
  const completed = update.runs.filter((run) => run.status === "completed").length
  const lines: string[] = [
    messages.reviewMidCiHeader(ctx.repo, ctx.prNumber, completed, update.runs.length),
    "",
  ]
  let index = 0
  for (const group of collectAuthorGroups(update.delta.newComments, update.delta.newReviews)) {
    lines.push(groupHeading(group, messages))
    for (const event of group.events) {
      index += 1
      lines.push(
        messages.reviewUnresolvedItem(
          index,
          itemLocation(event.path, event.line, messages),
          event.comment.url,
        ),
      )
      lines.push(...quoteBody(event.comment.body))
    }
    lines.push("")
  }
  lines.push(messages.reviewMidCiInstruction, "", ...renderMarkerInstruction(marker, locale))
  return lines.join("\n")
}

function threadContext(event: NewCommentEvent, snapshot: ReviewSnapshot, messages: Messages): string {
  if (event.threadId === null) return messages.prConversationContext
  const location = itemLocation(event.path, event.line, messages)
  const thread = snapshot.threads.find((candidate) => candidate.id === event.threadId)
  const isRoot = thread?.comments[0]?.databaseId === event.comment.databaseId
  return isRoot ? messages.newThreadContext(location) : messages.newReplyContext(location)
}

/** Template C: post-CI review update (new comments + PR status changes + readiness). */
export function renderPostCiReviewUpdate(
  delta: ReviewDelta,
  snapshot: ReviewSnapshot,
  readiness: ReviewReadiness | null,
  ctx: ReviewMessageContext,
  marker: string,
  locale: Locale = "en",
): string {
  const messages = CATALOGS[locale]
  const bodiedReviews = delta.newReviews.filter((review) => review.body.trim() !== "")
  const entryCount = delta.newComments.length + bodiedReviews.length
  const lines: string[] = [messages.reviewPostCiHeader(ctx.repo, ctx.prNumber), ""]
  if (entryCount > 0) {
    lines.push(messages.newCommentsSection(entryCount), "")
    let index = 0
    for (const group of collectAuthorGroups(delta.newComments, bodiedReviews)) {
      lines.push(groupHeading(group, messages))
      if (group.review) lines.push(...quoteBody(group.review.body))
      for (const event of group.events) {
        index += 1
        lines.push(`${index}. ${threadContext(event, snapshot, messages)} (${event.comment.url})`)
        lines.push(...quoteBody(event.comment.body))
      }
      lines.push("")
    }
  }
  const statusLines = statusChangeLines(delta, messages)
  if (statusLines.length > 0) lines.push(messages.prStatusChangeSection, ...statusLines, "")
  if (readiness !== null) {
    if (readiness.ready) lines.push(messages.readyToMerge, "")
    else {
      lines.push(messages.notReadyToMerge)
      lines.push(...readiness.blockers.map((blocker) => `- ${blocker}`), "")
    }
  }
  lines.push(messages.reviewAddressInstruction, "", ...renderMarkerInstruction(marker, locale))
  return lines.join("\n")
}

/** Template D: final message when the review watch ends ready-to-merge. No marker block. */
export function renderReviewEnded(
  args: { readonly snapshot: ReviewSnapshot; readonly delta: ReviewDelta; readonly reason: "ready" },
  ctx: ReviewMessageContext,
  locale: Locale = "en",
): string {
  const messages = CATALOGS[locale]
  const lines: string[] = [
    messages.reviewFinalHeader(ctx.repo, ctx.prNumber),
    "",
    messages.allThreadsResolved(args.delta.unresolved.from),
  ]
  const changes = [decisionLine(args.delta, messages), mergeStateLine(args.delta, messages)].filter(
    (line): line is string => line !== null,
  )
  if (changes.length > 0) lines.push("", ...changes)
  lines.push("", messages.prReadyToMerge(ctx.prNumber), "", messages.reviewWatchEnded)
  return lines.join("\n")
}

/** Template B's review section for the done report (T7 embeds `lines` and appends the marker block). */
export function renderReviewSection(
  snapshot: ReviewSnapshot,
  locale: Locale = "en",
): { readonly lines: readonly string[]; readonly unresolvedCount: number } {
  const messages = CATALOGS[locale]
  const unresolvedThreads = snapshot.threads.filter((thread) => !thread.isResolved)
  const rootEvents = unresolvedThreads.flatMap((thread) => {
    const root = thread.comments[0]
    if (root === undefined) return []
    return [
      { comment: root, threadId: thread.id, isResolved: thread.isResolved, path: root.path, line: root.line },
    ]
  })
  const bodiedReviews = snapshot.reviews.filter((review) => review.body.trim() !== "")
  const lines: string[] = [messages.reviewCommentsSection(unresolvedThreads.length), ""]
  let index = 0
  for (const group of collectAuthorGroups(rootEvents, bodiedReviews)) {
    lines.push(groupHeading(group, messages))
    if (group.review) lines.push(...quoteBody(group.review.body))
    for (const event of group.events) {
      index += 1
      lines.push(
        messages.reviewUnresolvedItem(
          index,
          itemLocation(event.path, event.line, messages),
          event.comment.url,
        ),
      )
      lines.push(...quoteBody(event.comment.body))
    }
    lines.push("")
  }
  while (lines.at(-1) === "") lines.pop()
  return { lines, unresolvedCount: unresolvedThreads.length }
}
