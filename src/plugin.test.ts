import { describe, expect, it } from "bun:test"
import { isGitPush } from "./plugin.ts"

describe("isGitPush", () => {
  it.each([
    ["git push", true],
    ["git push origin main", true],
    ["git push --force-with-lease origin feat/x", true],
    ["cd backend && git push", true],
    ["git -C /repo push origin main", true],
    ["git add . && git commit -m 'x' && git push", true],
    ["git push --dry-run", false],
    ["git pull origin main", false],
    ["echo push", false],
    ["git status", false],
  ])("classifies %j as push=%p", (command, expected) => {
    expect(isGitPush(command)).toBe(expected)
  })
})
