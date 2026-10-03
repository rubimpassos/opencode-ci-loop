import { describe, expect, it } from "bun:test"
import { requestedGuestCapabilities } from "@openchamber/sdk"
import { parseManifestJson } from "@openchamber/sdk/schemas"
import { injectedReports } from "./report-fixtures.test-support.ts"

const parsed = parseManifestJson(await Bun.file(new URL("../../package.json", import.meta.url)).text())

describe("OpenChamber manifest in package.json", () => {
  it("parses with the vendored SDK's manifest parser", () => {
    expect(parsed).toMatchObject({ ok: true })
  })

  it("derives loopback as the only requested capability", () => {
    const capabilities = parsed.ok ? requestedGuestCapabilities(parsed.manifest.contributes) : null

    expect(capabilities).toEqual(["loopback"])
  })
})

const contributes = parsed.ok ? parsed.manifest.contributes : null
// OpenChamber compiles message rules with the multiline flag (packages/ui/src/lib/guests/message-presentation.ts).
const messageRules = (contributes?.messages ?? []).map((rule) => ({
  rule,
  pattern: new RegExp(rule.match, "m"),
}))

describe("contributes.messages", () => {
  for (const locale of ["en", "pt-BR"] as const) {
    for (const [kind, text] of Object.entries(injectedReports(locale))) {
      it(`claims the ${locale} ${kind} report and titles it with its first line`, () => {
        // Given a report produced by the plugin's own renderer
        const firstLine = text.split("\n")[0] ?? ""

        // When OpenChamber runs the declared rule over it
        const match = messageRules[0]?.pattern.exec(text)

        // Then it is claimed from its first line, and the title is that line after the prefix
        expect(match?.index).toBe(0)
        expect(match?.groups?.["heading"]).toBe(firstLine.slice("[ci-loop] ".length))
      })
    }
  }

  it("leaves ordinary chat text unclaimed", () => {
    const claimed = messageRules.some(({ pattern }) =>
      pattern.test("please fix the ci-loop panel when you can"),
    )

    expect(claimed).toBe(false)
  })
})

describe("contributes.tools", () => {
  it("presents only the ci_watch tool", () => {
    expect(contributes?.tools?.map((tool) => tool.match)).toEqual(["ci_watch"])
  })
})
