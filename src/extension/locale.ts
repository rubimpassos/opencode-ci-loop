import type { Locale } from "../i18n.ts"

/** The plugin's supported `?locale=` overrides; Portuguese of any region maps to pt-BR. */
export type GuestLocale = Locale

export function guestLocale(hostLocale: string): GuestLocale {
  return /^pt(?:[-_]|$)/i.test(hostLocale.trim()) ? "pt-BR" : "en"
}
