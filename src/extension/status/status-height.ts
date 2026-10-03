import { clampStatusSectionHeight, HostRequestError } from "@openchamber/sdk"

/** The measured content owns the request; the host owns clamping and the iframe's scroll. */
export function trackStatusHeight(
  measure: () => number,
  send: (height: number) => Promise<void>,
  observe: (onResize: () => void) => () => void,
): { readonly fit: () => void; readonly dispose: () => void } {
  let last: number | null = null
  let disposed = false
  const fit = (): void => {
    if (disposed) return
    const height = clampStatusSectionHeight(Math.ceil(measure()))
    if (height === last) return
    last = height
    void send(height).catch((error: unknown) => {
      // A pagehide may dispose the host while an already-sent height RPC is pending.
      if (!(error instanceof HostRequestError)) throw error
    })
  }
  const disconnect = observe(fit)
  return {
    fit,
    dispose: () => {
      disposed = true
      disconnect()
    },
  }
}
