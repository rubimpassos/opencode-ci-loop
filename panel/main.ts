import { bootGuest } from "../src/extension/boot.ts"
import { renderStateLine } from "../src/extension/placeholder.ts"

const root = document.querySelector<HTMLElement>("#root")
if (!root) throw new Error("missing #root")
bootGuest((binding) => {
  renderStateLine(binding, root)
})
