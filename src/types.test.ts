import { describe, expect, it } from "bun:test"
import { PluginConfigSchema } from "./types.ts"

describe("PluginConfigSchema", () => {
  it("defaults language to auto and applies full review defaults on empty input", () => {
    const config = PluginConfigSchema.parse({})
    expect(config.language).toBe("auto")
    expect(config.review).toEqual({
      enabled: true,
      pollIntervalMs: 30_000,
      idleTimeoutMs: 3_600_000,
      agentMarker: "_🤖 via agent_",
      ignoreAuthors: [],
    })
  })

  it("accepts explicit language and review overrides", () => {
    const config = PluginConfigSchema.parse({
      language: "pt-BR",
      review: {
        enabled: false,
        pollIntervalMs: 5000,
        idleTimeoutMs: 60_000,
        agentMarker: "[via bot]",
        ignoreAuthors: ["dependabot[bot]", "renovate[bot]"],
      },
    })
    expect(config.language).toBe("pt-BR")
    expect(config.review).toEqual({
      enabled: false,
      pollIntervalMs: 5000,
      idleTimeoutMs: 60_000,
      agentMarker: "[via bot]",
      ignoreAuthors: ["dependabot[bot]", "renovate[bot]"],
    })
  })

  it("rejects review.pollIntervalMs below 5000", () => {
    expect(() => PluginConfigSchema.parse({ review: { pollIntervalMs: 4999 } })).toThrow()
  })

  it("rejects review.idleTimeoutMs below 60_000", () => {
    expect(() => PluginConfigSchema.parse({ review: { idleTimeoutMs: 59_999 } })).toThrow()
  })
})
