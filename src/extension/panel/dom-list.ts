/** Reorder existing keyed nodes in place. A retained <details> keeps its open state and scroll position. */
export function syncChildren(parent: HTMLElement, ordered: readonly HTMLElement[]): void {
  const live = new Set<Element>(ordered)
  for (const child of Array.from(parent.children)) if (!live.has(child)) child.remove()
  for (const [index, child] of ordered.entries()) {
    const current = parent.children.item(index)
    if (current !== child) parent.insertBefore(child, current)
  }
}

export function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  element.className = className
  return element
}
