import { describe, expect, it } from "bun:test"
import { describeConnection } from "./connection-view.ts"
import { guestLocale } from "./locale.ts"

describe("guestLocale", () => {
  it.each([
    ["pt-BR", "pt-BR"],
    ["pt", "pt-BR"],
    ["pt-PT", "pt-BR"],
    ["PT_br", "pt-BR"],
    ["en-US", "en"],
    ["es", "en"],
    ["", "en"],
  ] as const)("maps host locale %p to %p", (host, expected) => {
    expect(guestLocale(host)).toBe(expected)
  })
})

describe("describeConnection", () => {
  it("flags retained data as stale instead of presenting it as healthy", () => {
    const state = { connection: { kind: "live" }, snapshot: null, locale: "en" } as const
    const fresh = describeConnection({ ...state, stale: false })
    const stale = describeConnection({ ...state, stale: true })

    expect(fresh.tone).toBe("success")
    expect(stale.tone).toBe("warning")
    expect(stale.text).not.toBe(fresh.text)
  })

  it("distinguishes an outdated plugin from unreadable data", () => {
    const state = { snapshot: null, stale: false, locale: "pt-BR" } as const
    const outdated = describeConnection({
      ...state,
      connection: { kind: "invalid-data", reason: "update-required" },
    })
    const unreadable = describeConnection({
      ...state,
      connection: { kind: "invalid-data", reason: "unreadable" },
    })

    expect(outdated.text).not.toBe(unreadable.text)
  })
})
