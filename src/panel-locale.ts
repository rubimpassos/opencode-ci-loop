import { type Locale, type Messages, resolveLocale } from "./i18n.ts"
import type { PanelChrome } from "./panel-types.ts"
import type { SessionId, SessionState } from "./types.ts"

/**
 * Locale of the panel chrome (page title, filters, empty states) — one per page, unlike the
 * per-session strings. An explicit `language` wins; `"auto"` follows the most recently started
 * watch ("what you're looking at wins"), ties broken by `sessionID` ascending; otherwise `en`.
 */
export function panelLocale(
  language: string,
  sessions: readonly SessionState[],
  locales: ReadonlyMap<SessionId, Locale>,
): Locale {
  const owner = newestWatchOwner(sessions)
  return resolveLocale(language, owner === null ? undefined : locales.get(owner))
}

function newestWatchOwner(sessions: readonly SessionState[]): SessionId | null {
  let owner: SessionId | null = null
  let startedAt = Number.NEGATIVE_INFINITY
  for (const session of sessions) {
    for (const watch of session.watches) {
      const wins =
        watch.startedAt > startedAt ||
        (watch.startedAt === startedAt && owner !== null && session.sessionID < owner)
      if (wins) {
        owner = session.sessionID
        startedAt = watch.startedAt
      }
    }
  }
  return owner
}

export function buildChrome(messages: Messages): PanelChrome {
  return {
    pageTitle: messages.panelPageTitle,
    emptyWaiting: messages.panelEmptyWaiting,
    noMatches: messages.panelNoMatches,
    searchPlaceholder: messages.panelSearchPlaceholder,
    filtersLabel: messages.panelFiltersLabel,
    filterEnabledAll: messages.panelFilterEnabledAll,
    filterEnabledOn: messages.panelFilterEnabledOn,
    filterEnabledOff: messages.panelFilterEnabledOff,
    watchOn: messages.panelWatchOn,
    watchOff: messages.panelWatchOff,
    clearFilters: messages.panelClearFilters,
    hiddenTemplate: messages.panelHiddenTemplate,
    phaseChips: {
      waiting: messages.panelPhaseChip("waiting"),
      running: messages.panelPhaseChip("running"),
      "done-green": messages.panelPhaseChip("done-green"),
      "done-failed": messages.panelPhaseChip("done-failed"),
      reviewing: messages.panelPhaseChip("reviewing"),
      "review-ended": messages.panelPhaseChip("review-ended"),
      "timed-out": messages.panelPhaseChip("timed-out"),
      error: messages.panelPhaseChip("error"),
    },
  }
}
