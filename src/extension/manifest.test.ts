import { describe, expect, it } from "bun:test"
import { requestedGuestCapabilities } from "@openchamber/sdk"
import { parseManifestJson } from "@openchamber/sdk/schemas"

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
