import { describe, expect, it } from "bun:test"
import { isAllowedHost } from "./server.ts"

describe("isAllowedHost", () => {
  it.each([
    ["127.0.0.1:4517", true],
    ["localhost:4517", true],
    ["LOCALHOST:4517", true],
    ["[::1]:4517", true],
    ["evil.example.com:4517", false],
    ["127.0.0.1:9999", false],
    ["127.0.0.1", false],
    [null, false],
  ])("host %j allowed=%p on port 4517", (hostHeader, expected) => {
    expect(isAllowedHost(hostHeader, 4517)).toBe(expected)
  })
})
