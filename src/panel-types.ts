import type { RunStatus } from "./types.ts"

/** Chip render order in the filter bar — this array order is a UI contract. */
export const PANEL_PHASE_KEYS = [
  "waiting",
  "running",
  "done-green",
  "done-failed",
  "reviewing",
  "review-ended",
  "timed-out",
  "error",
] as const
export type PanelPhaseKey = (typeof PANEL_PHASE_KEYS)[number]

export const PANEL_TONES = ["info", "ok", "fail", "warn"] as const
export type PanelTone = (typeof PANEL_TONES)[number]

export type PanelRun = {
  readonly name: string
  readonly url: string
  readonly status: RunStatus
  readonly state: string
}

export type PanelCheck = {
  readonly name: string
  readonly url: string | null
  readonly state: string
  readonly failing: boolean
}

export type PanelFailure = { readonly runName: string; readonly logTail: string }

export type PanelPr = {
  readonly number: number
  readonly title: string
  readonly url: string
  readonly ready: boolean
  /** Localized verdict: readyToMerge | notReadyToMerge. */
  readonly verdictLabel: string
  /** Localized, FULL blocker list — never truncated by the client. */
  readonly blockers: readonly string[]
  /** Localized "draft"; null when the PR is not a draft. */
  readonly draftLabel: string | null
}

export type PanelWatch = {
  /** `${repo}\0${branch}` — stable list key. */
  readonly key: string
  /** Localized "repo · branch · source · sha8". */
  readonly meta: string
  readonly phaseKey: PanelPhaseKey
  readonly tone: PanelTone
  /** Localized. */
  readonly phaseLabel: string
  /**
   * CI failure carried by this stored watch: `error`, or a report that is not clean (done/reviewing/
   * review-ended). PR-only blockers do not count; reviewing alone is not a failure.
   */
  readonly failed: boolean
  readonly runs: readonly PanelRun[]
  readonly checks: readonly PanelCheck[]
  readonly failures: readonly PanelFailure[]
  readonly pr: PanelPr | null
  /** Lowercased haystack (session + watch fields). */
  readonly searchText: string
}

export type PanelSession = {
  readonly sessionID: string
  /** RAW, never pre-escaped — the client escapes; double-escaping is a bug. */
  readonly title: string | null
  /** Directory basename. */
  readonly projectLabel: string | null
  /** Full path, for the title attribute. */
  readonly directory: string | null
  readonly enabled: boolean
  readonly watches: readonly PanelWatch[]
  readonly searchText: string
}

export type PanelChrome = {
  readonly pageTitle: string
  readonly emptyWaiting: string
  readonly noMatches: string
  readonly searchPlaceholder: string
  readonly filtersLabel: string
  readonly filterEnabledAll: string
  readonly filterEnabledOn: string
  readonly filterEnabledOff: string
  readonly watchOn: string
  readonly watchOff: string
  readonly clearFilters: string
  /** Carries the literal `{n}` token — the client substitutes the count it computes. */
  readonly hiddenTemplate: string
  readonly phaseChips: Readonly<Record<PanelPhaseKey, string>>
}

export type PanelSnapshot = { readonly chrome: PanelChrome; readonly sessions: readonly PanelSession[] }
