import { mock } from "bun:test"

/** Only the UI-kit boundary is faked; panel code still creates and reconciles actual DOM nodes. */
export function mockUiKit(): void {
  mock.module("@openchamber/sdk/ui", () => ({
    mountBanner(root: Element, initial: { tone: string; title: string; body?: string }) {
      const element = document.createElement("div")
      element.setAttribute("role", "status")
      root.append(element)
      let props = initial
      const paint = (): void => {
        element.textContent = `${props.title} ${props.body ?? ""}`.trim()
      }
      paint()
      return {
        update(next: Partial<typeof initial>) {
          props = { ...props, ...next }
          paint()
        },
        dispose() {
          element.remove()
        },
      }
    },
    mountEmpty(root: Element, initial: { title: string }) {
      const element = document.createElement("div")
      root.append(element)
      element.textContent = initial.title
      return {
        update(next: Partial<typeof initial>) {
          element.textContent = next.title ?? initial.title
        },
        dispose() {
          element.remove()
        },
      }
    },
    mountBadge(root: Element, initial: { label: string; tone: string }) {
      const element = document.createElement("span")
      root.append(element)
      element.textContent = initial.label
      return {
        update(next: Partial<typeof initial>) {
          element.textContent = next.label ?? initial.label
        },
        dispose() {
          element.remove()
        },
      }
    },
    mountButton(root: Element, initial: { label: string; disabled?: boolean; onClick: () => void }) {
      const element = document.createElement("button")
      element.type = "button"
      root.append(element)
      let props = initial
      element.addEventListener("click", () => {
        if (!props.disabled) props.onClick()
      })
      const paint = (): void => {
        element.textContent = props.label
        element.disabled = props.disabled ?? false
      }
      paint()
      return {
        update(next: Partial<typeof initial>) {
          props = { ...props, ...next }
          paint()
        },
        dispose() {
          element.remove()
        },
      }
    },
    mountTextField(
      root: Element,
      initial: { label: string; value: string; placeholder?: string; onChange: (value: string) => void },
    ) {
      const label = document.createElement("label")
      const text = document.createElement("span")
      const input = document.createElement("input")
      input.type = "search"
      label.append(text, input)
      root.append(label)
      input.addEventListener("input", () => initial.onChange(input.value))
      text.textContent = initial.label
      input.value = initial.value
      return {
        update(next: Partial<typeof initial>) {
          if (next.label !== undefined) text.textContent = next.label
          if (next.value !== undefined) input.value = next.value
        },
        dispose() {
          label.remove()
        },
      }
    },
    mountSwitch(
      root: Element,
      initial: { label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void },
    ) {
      const button = document.createElement("button")
      button.type = "button"
      button.setAttribute("role", "switch")
      root.append(button)
      let props = initial
      button.addEventListener("click", () => {
        if (!props.disabled) props.onChange(!props.checked)
      })
      const paint = (): void => {
        button.textContent = props.label
        button.disabled = props.disabled ?? false
        button.setAttribute("aria-checked", String(props.checked))
      }
      paint()
      return {
        update(next: Partial<typeof initial>) {
          props = { ...props, ...next }
          paint()
        },
        dispose() {
          button.remove()
        },
      }
    },
  }))
}
