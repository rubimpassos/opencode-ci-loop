import { EN } from "./i18n-en.ts"
import { PT_BR } from "./i18n-pt-br.ts"

export const LOCALES = ["en", "pt-BR"] as const
export type Locale = (typeof LOCALES)[number]

/**
 * Every localized string the plugin injects or toasts. Adding a locale = adding one Messages object.
 * Technical tokens (enum values, URLs, logins, `[ci-loop]` prefix, markdown structure, icons) stay verbatim.
 */
export interface Messages {
  // CI toasts (plugin.ts notifyPhase)
  toastWaiting(context: string): string
  toastRunning(runsSummary: string, context: string): string
  toastTimedOut(context: string): string
  toastWatchError(message: string, context: string): string
  toastCiGreen(checks: number): string
  readonly toastCiFailed: string
  readonly toastPrReady: string
  toastPrBlocked(issues: number): string

  // CI report (render.ts renderPromptReport)
  ciResultHeader(repo: string, branch: string, shaShort: string): string
  sourceLine(label: string): string
  readonly otherChecksHeader: string
  readonly pullRequestSection: string
  draftLine(isDraft: boolean): string
  readonly readyToMerge: string
  readonly notReadyToMerge: string
  readonly failingRulesHeader: string
  readonly allPassedPrReady: string
  readonly ciPassedReviewBlockers: string
  readonly allPassedNoPr: string
  readonly failureLogsSection: string
  readonly failureLogsPreamble1: string
  readonly failureLogsPreamble2: string
  readonly fixInstruction1: string
  readonly fixInstruction2: string

  // prReadiness blockers/warnings (render.ts)
  rebaseWarning(commitCount: number, limit: number): string
  readonly blockerDraft: string
  readonly blockerConflicts: string
  readonly blockerBehind: string
  readonly blockerBranchProtection: string
  readonly blockerMergeHooks: string
  readonly blockerChecksUnstable: string
  readonly blockerChangesRequested: string
  readonly blockerReviewRequired: string
  readonly blockerCiFailing: string
  readonly blockerMergeabilityPending: string
  blockerUnresolvedConversations(count: number): string

  // Review messages A/B/C/D (render-review.ts)
  reviewMidCiHeader(repo: string, prNumber: number, completed: number, total: number): string
  reviewPostCiHeader(repo: string, prNumber: number): string
  reviewFinalHeader(repo: string, prNumber: number): string
  reviewGroupLine(authorLabel: string, state: string, count: number): string
  reviewUnresolvedItem(index: number, location: string, url: string): string
  readonly reviewMidCiInstruction: string
  reviewCommentsSection(unresolved: number): string
  readonly reviewKeepsWatching: string
  newCommentsSection(count: number): string
  readonly prStatusChangeSection: string
  decisionChangeLine(from: string, to: string): string
  unresolvedChangeLine(from: number, to: number): string
  mergeStateChangeLine(from: string, to: string): string
  readonly reviewAddressInstruction: string
  allThreadsResolved(from: number): string
  prReadyToMerge(prNumber: number): string
  readonly reviewWatchEnded: string
  markerInstruction(marker: string): string
  newThreadContext(location: string): string
  newReplyContext(location: string): string
  readonly prConversationContext: string

  // Review toasts
  toastCopilotReview(count: number, prNumber: number): string
  toastNewComment(login: string, prNumber: number): string
  toastReviewUpdate(summary: string, prNumber: number): string
  toastAllResolved(prNumber: number): string
  toastReviewIdle(prNumber: number): string
  toastPrMerged(prNumber: number): string
  toastPrClosed(prNumber: number): string
}

export const CATALOGS: Record<Locale, Messages> = { en: EN, "pt-BR": PT_BR }

const PT_ACCENT_PATTERN = /[ãõçáéíóúâêô]/i
const PT_STOPWORDS = [
  "você",
  "não",
  "está",
  "para",
  "como",
  "isso",
  "fazer",
  "por favor",
  "também",
  "obrigado",
] as const
const PT_STOPWORD_PATTERNS = PT_STOPWORDS.map((word) => new RegExp(`(?<!\\p{L})${word}(?!\\p{L})`, "iu"))

/** pt-BR iff the text has Portuguese accents OR ≥2 stopword hits (lock §10); undetectable → en. */
export function detectLocale(text: string): Locale {
  if (PT_ACCENT_PATTERN.test(text)) return "pt-BR"
  const hits = PT_STOPWORD_PATTERNS.filter((pattern) => pattern.test(text)).length
  return hits >= 2 ? "pt-BR" : "en"
}

/** Explicit valid config value wins; "auto" defers to the detected locale; unknown values → en. */
export function resolveLocale(configLanguage: string, detected?: Locale): Locale {
  const explicit = LOCALES.find((locale) => locale === configLanguage)
  if (explicit) return explicit
  if (configLanguage === "auto") return detected ?? "en"
  return "en"
}
