import type { Plugin } from "@opencode-ai/plugin"
import { detectLocale, type Locale, resolveLocale } from "./i18n.ts"
import type { SessionId } from "./types.ts"

export type OpencodeClient = Parameters<Plugin>[0]["client"]
export type SessionModel = { readonly providerID: string; readonly modelID: string }
export type SessionContext = { readonly model?: SessionModel; readonly locale: Locale }

type MessagesData = NonNullable<Awaited<ReturnType<OpencodeClient["session"]["messages"]>>["data"]>

function lastUserText(entries: MessagesData): string {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry === undefined || entry.info.role !== "user") continue
    return entry.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
  }
  return ""
}

/**
 * One `session.messages` fetch serving both concerns of an injection path:
 * the model last used in the session (so the injected report replies on it — not the agent
 * default) and the session locale (detected from the last user message, cached in `locales`;
 * an explicit config `language` wins regardless).
 */
export async function resolveSessionContext(
  client: OpencodeClient,
  sessionID: SessionId,
  configLanguage: string,
  locales: Map<SessionId, Locale>,
): Promise<SessionContext> {
  let model: SessionModel | undefined
  try {
    const response = await client.session.messages({ path: { id: sessionID } })
    const entries = response.data ?? []
    for (let index = entries.length - 1; index >= 0; index--) {
      const info = entries[index]?.info
      if (info?.role === "assistant") {
        model = { providerID: info.providerID, modelID: info.modelID }
        break
      }
    }
    if (configLanguage === "auto" && !locales.has(sessionID)) {
      locales.set(sessionID, detectLocale(lastUserText(entries)))
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error
  }
  return { ...(model && { model }), locale: resolveLocale(configLanguage, locales.get(sessionID)) }
}
