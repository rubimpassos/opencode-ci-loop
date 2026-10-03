import type { CiLoopHost, SessionModel } from "./host-port.ts"
import { detectLocale, type Locale, resolveLocale } from "./i18n.ts"
import type { PluginConfig, SessionId } from "./types.ts"

export type SessionContext = { readonly model?: SessionModel; readonly locale: Locale }
type ContextSource = {
  readonly host: CiLoopHost
  readonly config: Pick<PluginConfig, "language">
  readonly locales: Map<SessionId, Locale>
}

/** One host read supplies the last assistant model and last user text; locale detection is cached. */
export async function resolveSessionContext(
  source: ContextSource,
  sessionID: SessionId,
  signal?: AbortSignal,
): Promise<SessionContext> {
  let model: SessionModel | undefined
  try {
    const context = await source.host.readSessionContext(sessionID, signal)
    if (!signal?.aborted) {
      model = context.model
      if (source.config.language === "auto" && !source.locales.has(sessionID)) {
        source.locales.set(sessionID, detectLocale(context.lastUserText))
      }
    }
  } catch (error) {
    // Preserve V1's fallback when session history is unavailable.
    if (!(error instanceof Error)) throw error
  }
  return {
    ...(model && { model }),
    locale: resolveLocale(source.config.language, source.locales.get(sessionID)),
  }
}
