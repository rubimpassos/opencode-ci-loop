import { bindBadge } from "../src/extension/badge.ts"
import { bootGuest } from "../src/extension/boot.ts"

// The automatic background frame is the extension's only badge writer. Registered before
// `bootGuest` so the badge is cleared while the host connection is still open.
let stopBadge: () => void = () => {}
window.addEventListener("pagehide", () => stopBadge())
bootGuest((binding, host) => {
  stopBadge = bindBadge(binding, (count) => host.setBadge(count))
})
