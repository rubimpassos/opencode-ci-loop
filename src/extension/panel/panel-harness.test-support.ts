import type { PanelSnapshot } from "../../panel-types.ts"
import { createPanelBinding } from "../binding.ts"
import { fakeClock, fakeHost } from "../fake-host.test-support.ts"
import { withDom } from "./dom-stub.test-support.ts"
import { mockUiKit } from "./ui-stub.test-support.ts"

mockUiKit()
const { renderPanel } = await import("./panel-view.ts")

export function panelHarness() {
  const { dom, restore } = withDom()
  const fake = fakeHost()
  const opened: string[] = []
  const host = {
    ...fake,
    openUrl: async (url: string) => {
      opened.push(url)
    },
  }
  const binding = createPanelBinding({ host, locale: "en", schedule: fakeClock().schedule })
  const root = document.createElement("div")
  const dispose = renderPanel(binding, host, root)
  return {
    root,
    dom,
    fake,
    binding,
    opened,
    push: (snapshot: PanelSnapshot) =>
      fake.watches[0]?.emit({ type: "data", text: JSON.stringify(snapshot) }),
    close: () => {
      dispose()
      binding.dispose()
      restore()
    },
  }
}
