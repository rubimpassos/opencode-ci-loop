import { bootGuest } from "../src/extension/boot.ts"
import { mountStatusView } from "../src/extension/status/status-view.ts"

const root = document.querySelector<HTMLElement>("#root")
if (!root) throw new Error("missing #root")
bootGuest((binding, host) => {
  const dispose = mountStatusView(binding, host, root)
  window.addEventListener("pagehide", dispose, { once: true })
})
