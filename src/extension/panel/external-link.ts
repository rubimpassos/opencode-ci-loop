import type { HostClient } from "@openchamber/sdk"
import type { GuestLocale } from "../locale.ts"
import { node } from "./dom-list.ts"

/** Accept absolute browser URLs only. Never pass a payload URL to the host without this parse. */
export function safeExternalUrl(raw: string | null): string | null {
  if (raw === null) return null
  try {
    const url = new URL(raw)
    return (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname !== "" &&
      url.username === "" &&
      url.password === ""
      ? url.href
      : null
  } catch (error) {
    if (error instanceof TypeError) return null
    throw error
  }
}

export function externalLink(host: Pick<HostClient, "openUrl">, locale: GuestLocale) {
  const element = node("span", "ci-external")
  const link = node("button", "ci-link")
  const plain = node("span", "ci-plain")
  const error = node("span", "ci-link-error")
  link.type = "button"
  error.setAttribute("role", "alert")
  let target: string | null = null
  link.addEventListener("click", () => {
    if (target === null) return
    error.textContent = ""
    void host.openUrl(target).catch((cause: unknown) => {
      if (!(cause instanceof Error)) throw cause
      error.textContent = locale === "pt-BR" ? "Não foi possível abrir o link." : "Could not open the link."
    })
  })
  element.append(link, plain, error)
  return {
    element,
    update(label: string, url: string | null): void {
      target = safeExternalUrl(url)
      link.textContent = label
      plain.textContent = label
      link.hidden = target === null
      plain.hidden = target !== null
      error.textContent = ""
    },
  }
}
