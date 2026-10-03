import { bootGuest } from "../src/extension/boot.ts"
import { renderPanel } from "../src/extension/panel/panel-view.ts"

const root = document.querySelector<HTMLElement>("#root")
if (!root) throw new Error("missing #root")
bootGuest((binding, host) => {
  const dispose = renderPanel(binding, host, root)
  window.addEventListener("pagehide", dispose, { once: true })
})
