import { connectHost, type HostClient } from "@openchamber/sdk"
import { applyHostReady } from "@openchamber/sdk/ui"
import { createPanelBinding, type PanelBinding } from "./binding.ts"
import { guestLocale } from "./locale.ts"

/**
 * Connects a guest page to the host and to the shared panel binding. The host re-sends `ready` on
 * theme/locale changes: the theme is re-applied and the binding re-subscribes only on a new locale.
 */
export function bootGuest(onBinding: (binding: PanelBinding, host: HostClient) => void): void {
  const host = connectHost()
  let binding: PanelBinding | null = null
  host.onReady((context) => {
    applyHostReady(context, document.documentElement)
    const locale = guestLocale(context.locale)
    if (binding) {
      binding.setLocale(locale)
    } else {
      binding = createPanelBinding({ host, locale })
      onBinding(binding, host)
    }
  })
  window.addEventListener("pagehide", () => {
    binding?.dispose()
    host.dispose()
  })
}
