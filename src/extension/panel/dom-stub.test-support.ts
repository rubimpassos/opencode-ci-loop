/** Small DOM for behavior tests; intentionally parses no HTML and executes no payload strings. */
export class TestElement {
  readonly children: TestElement[] & { item(index: number): TestElement | null }
  readonly dataset: Record<string, string> = {}
  readonly attributes = new Map<string, string>()
  readonly listeners = new Map<string, (() => void)[]>()
  readonly classList = {
    toggle: (name: string, active: boolean): void => {
      const classes = new Set(this.className.split(" ").filter(Boolean))
      if (active) classes.add(name)
      else classes.delete(name)
      this.className = [...classes].join(" ")
    },
  }
  parent: TestElement | null = null
  className = ""
  title = ""
  value = ""
  type = ""
  hidden = false
  disabled = false
  open = false
  selectionStart = 0
  selectionEnd = 0
  scrollTop = 0
  private text = ""

  constructor(
    readonly tagName: string,
    private readonly owner: TestDocument,
  ) {
    const children: TestElement[] = []
    this.children = Object.assign(children, { item: (index: number) => children[index] ?? null })
  }

  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join("")
  }
  set textContent(value: string | null) {
    this.replaceChildren()
    this.text = value ?? ""
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }
  append(...nodes: TestElement[]): void {
    for (const child of nodes) this.insertBefore(child, null)
  }
  insertBefore(child: TestElement, reference: TestElement | null): void {
    child.remove()
    const index = reference === null ? -1 : this.children.indexOf(reference)
    this.children.splice(index < 0 ? this.children.length : index, 0, child)
    child.parent = this
  }
  replaceChildren(...nodes: TestElement[]): void {
    for (const child of [...this.children]) child.remove()
    this.text = ""
    this.append(...nodes)
  }
  remove(): void {
    if (this.parent) {
      this.parent.children.splice(this.parent.children.indexOf(this), 1)
      this.parent = null
    }
  }
  addEventListener(type: string, listener: () => void): void {
    const entries = this.listeners.get(type) ?? []
    entries.push(listener)
    this.listeners.set(type, entries)
  }
  fire(type: string): void {
    if (this.disabled) return
    for (const listener of this.listeners.get(type) ?? []) listener()
  }
  dispatchEvent(event: Event): boolean {
    this.fire(event.type)
    return true
  }
  click(): void {
    this.fire("click")
  }
  focus(): void {
    this.owner.activeElement = this
  }
  querySelector(selector: string): TestElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }
  querySelectorAll(selector: string): TestElement[] {
    const matches: TestElement[] = []
    const find = (root: TestElement): void => {
      for (const child of root.children) {
        if (
          (selector.startsWith(".") && child.className.split(" ").includes(selector.slice(1))) ||
          (selector === '[role="switch"]' && child.getAttribute("role") === "switch") ||
          child.tagName === selector
        )
          matches.push(child)
        find(child)
      }
    }
    find(this)
    return matches
  }
}

export class TestDocument {
  title = ""
  activeElement: TestElement | null = null
  readonly head = new TestElement("head", this)
  createElement(tag: string): TestElement {
    return new TestElement(tag, this)
  }
}

export function withDom(): { readonly dom: TestDocument; readonly restore: () => void } {
  const previous: unknown = Reflect.get(globalThis, "document")
  const existed = Object.hasOwn(globalThis, "document")
  const dom = new TestDocument()
  Reflect.set(globalThis, "document", dom)
  return {
    dom,
    restore: () => {
      if (existed) Reflect.set(globalThis, "document", previous)
      else Reflect.deleteProperty(globalThis, "document")
    },
  }
}
