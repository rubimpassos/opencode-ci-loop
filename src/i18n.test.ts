import { describe, expect, it } from "bun:test"
import { CATALOGS, detectLocale, LOCALES, type Locale, resolveLocale } from "./i18n.ts"

describe("detectLocale", () => {
  const table: readonly { readonly text: string; readonly expected: Locale }[] = [
    { text: "você pode corrigir isso por favor", expected: "pt-BR" },
    { text: "Ação necessária no build", expected: "pt-BR" },
    { text: "quero fazer isso para amanha", expected: "pt-BR" },
    { text: "Please fix the CI failure and push again", expected: "en" },
    { text: "", expected: "en" },
    { text: "asdf qwer zxcv 12345", expected: "en" },
    { text: "can you fix isso", expected: "en" },
    { text: "the paragraph explains the comparison", expected: "en" },
  ]

  for (const { text, expected } of table) {
    it(`detects ${expected} for ${JSON.stringify(text)}`, () => {
      expect(detectLocale(text)).toBe(expected)
    })
  }
})

describe("resolveLocale", () => {
  it("uses an explicit valid config value over the detected locale", () => {
    expect(resolveLocale("pt-BR")).toBe("pt-BR")
    expect(resolveLocale("pt-BR", "en")).toBe("pt-BR")
    expect(resolveLocale("en", "pt-BR")).toBe("en")
  })

  it("falls back to the detected locale on auto", () => {
    expect(resolveLocale("auto", "pt-BR")).toBe("pt-BR")
    expect(resolveLocale("auto", "en")).toBe("en")
    expect(resolveLocale("auto")).toBe("en")
  })

  it("resolves unknown config values to en", () => {
    expect(resolveLocale("fr")).toBe("en")
    expect(resolveLocale("klingon", "pt-BR")).toBe("en")
  })
})

for (const locale of LOCALES) {
  describe(`CATALOGS[${locale}] templates`, () => {
    const messages = CATALOGS[locale]

    it("interpolates review headers with repo, PR number and CI progress", () => {
      const midCi = messages.reviewMidCiHeader("github.com/o/r", 12, 1, 3)
      expect(midCi).toContain("[ci-loop]")
      expect(midCi).toContain("github.com/o/r")
      expect(midCi).toContain("PR #12")
      expect(midCi).toContain("1/3")
      expect(messages.reviewPostCiHeader("github.com/o/r", 12)).toContain("PR #12")
      expect(messages.reviewFinalHeader("github.com/o/r", 12)).toContain("PR #12")
    })

    it("keeps counters in section titles and the final resolved line", () => {
      expect(messages.reviewCommentsSection(4)).toContain("(4")
      expect(messages.reviewCommentsSection(4)).toStartWith("## ")
      expect(messages.newCommentsSection(2)).toContain("(2)")
      expect(messages.newCommentsSection(2)).toStartWith("## ")
      expect(messages.prStatusChangeSection).toStartWith("## ")
      expect(messages.allThreadsResolved(3)).toContain("3 → 0")
    })

    it("renders status delta lines with verbatim technical tokens", () => {
      expect(messages.decisionChangeLine("—", "CHANGES_REQUESTED")).toBe(
        "reviewDecision: — → CHANGES_REQUESTED",
      )
      expect(messages.mergeStateChangeLine("UNSTABLE", "BLOCKED")).toBe(
        "mergeStateStatus: UNSTABLE → BLOCKED",
      )
      expect(messages.unresolvedChangeLine(2, 4)).toContain("2 → 4")
    })

    it("embeds the marker string in the three-line marker instruction block", () => {
      const block = messages.markerInstruction("_🤖 via agent_")
      const lines = block.split("\n")
      expect(lines).toHaveLength(3)
      expect(lines[0]).toBe("---")
      expect(lines[1]).toContain("_🤖 via agent_")
      expect(lines[2]).not.toContain("_🤖 via agent_")
    })

    it("keeps the review-watch-ended literal", () => {
      expect(messages.reviewWatchEnded).toBe("[review watch ended]")
    })

    it("numbers unresolved review items with location and url", () => {
      const item = messages.reviewUnresolvedItem(
        2,
        "src/gh.ts:42",
        "https://github.com/o/r/pull/7#discussion_r1",
      )
      expect(item).toStartWith("2. ❌ ")
      expect(item).toContain("`src/gh.ts:42`")
      expect(item).toContain("https://github.com/o/r/pull/7#discussion_r1")
    })

    it("keeps author label, review state and count in the group line", () => {
      const line = messages.reviewGroupLine("🤖 **Copilot**", "CHANGES_REQUESTED", 3)
      expect(line).toContain("🤖 **Copilot**")
      expect(line).toContain("CHANGES_REQUESTED")
      expect(line).toContain("3")
    })

    it("counts unresolved conversations in the readiness blocker", () => {
      expect(messages.blockerUnresolvedConversations(5)).toContain("5")
    })

    it("interpolates thread-context pieces with the location", () => {
      expect(messages.newThreadContext("src/gh.ts:42")).toContain("`src/gh.ts:42`")
      expect(messages.newReplyContext("src/gh.ts:42")).toContain("`src/gh.ts:42`")
      expect(messages.prConversationContext.length).toBeGreaterThan(0)
    })

    it("interpolates review toasts with PR number, count and login", () => {
      expect(messages.prReadyToMerge(7)).toContain("PR #7")
      expect(messages.prReadyToMerge(7)).toContain("✅")
      expect(messages.toastCopilotReview(3, 7)).toContain("PR #7")
      expect(messages.toastCopilotReview(3, 7)).toContain("3")
      expect(messages.toastNewComment("octocat", 7)).toContain("octocat")
      expect(messages.toastNewComment("octocat", 7)).toContain("PR #7")
      expect(messages.toastReviewUpdate("2 threads resolved", 7)).toContain("2 threads resolved")
      expect(messages.toastAllResolved(7)).toContain("PR #7")
      expect(messages.toastReviewIdle(7)).toContain("PR #7")
      expect(messages.toastPrMerged(7)).toContain("PR #7")
      expect(messages.toastPrClosed(7)).toContain("PR #7")
    })

    it("keeps structural markers in the rebase warning", () => {
      const warning = messages.rebaseWarning(150, 100)
      expect(warning).toContain("150")
      expect(warning).toContain("100")
    })
  })
}

describe("CATALOGS.en keeps the existing plugin strings byte-identical", () => {
  const en = CATALOGS.en

  it("keeps CI toast pieces", () => {
    expect(en.toastWaiting("ctx")).toBe("Waiting for CI to start… · ctx")
    expect(en.toastRunning("1/2 completed", "ctx")).toBe("CI: 1/2 completed · ctx")
    expect(en.toastTimedOut("ctx")).toBe("Timed out waiting for CI · ctx")
    expect(en.toastWatchError("boom", "ctx")).toBe("CI watch failed: boom · ctx")
    expect(en.toastCiGreen(5)).toBe("CI green (5 checks)")
    expect(en.toastCiFailed).toBe("CI failed — injecting report")
    expect(en.toastPrReady).toBe("ready to merge")
    expect(en.toastPrBlocked(1)).toBe("blocked: 1 issue")
    expect(en.toastPrBlocked(2)).toBe("blocked: 2 issues")
  })

  it("keeps report structural lines", () => {
    expect(en.ciResultHeader("github.com/o/r", "main", "abcdef12")).toBe(
      "[ci-loop] CI result for github.com/o/r · main push `abcdef12`:",
    )
    expect(en.sourceLine("current branch of this session")).toBe("Source: current branch of this session")
    expect(en.otherChecksHeader).toBe("Other checks on the PR (external apps / commit statuses):")
    expect(en.pullRequestSection).toBe("## Pull request")
    expect(en.draftLine(true)).toBe("Draft: yes")
    expect(en.draftLine(false)).toBe("Draft: no")
    expect(en.readyToMerge).toBe("✅ Ready to merge")
    expect(en.notReadyToMerge).toBe("🚧 Not ready to merge:")
    expect(en.failingRulesHeader).toBe("Failing rules (GitHub ruleset evaluation for this branch):")
    expect(en.failureLogsSection).toBe("## Failure logs")
  })

  it("keeps prReadiness blocker strings", () => {
    expect(en.blockerDraft).toBe("PR is a draft")
    expect(en.blockerConflicts).toBe("Merge conflicts with the base branch")
    expect(en.blockerBehind).toBe("Behind the base branch")
    expect(en.blockerBranchProtection).toBe("Blocked (branch protection / required checks)")
    expect(en.blockerMergeHooks).toBe("Merge hooks are still pending")
    expect(en.blockerChecksUnstable).toBe("Required checks are not all successful")
    expect(en.blockerChangesRequested).toBe("Changes requested in review")
    expect(en.blockerReviewRequired).toBe("Awaiting required review")
    expect(en.blockerCiFailing).toBe("CI checks failing")
    expect(en.blockerMergeabilityPending).toBe("GitHub hasn't computed mergeability yet")
  })
})

describe("CATALOGS[pt-BR]", () => {
  const ptBR = CATALOGS["pt-BR"]

  it("keeps technical tokens verbatim", () => {
    const header = ptBR.ciResultHeader("github.com/o/r", "main", "abcdef12")
    expect(header).toContain("[ci-loop]")
    expect(header).toContain("`abcdef12`")
    expect(ptBR.reviewMidCiHeader("github.com/o/r", 12, 1, 3)).toContain("[ci-loop]")
    expect(ptBR.reviewGroupLine("🤖 **Copilot**", "CHANGES_REQUESTED", 3)).toContain("CHANGES_REQUESTED")
    expect(ptBR.markerInstruction("_🤖 via agent_")).toContain("`gh`")
  })

  it("localizes the injected instruction strings", () => {
    expect(ptBR.readyToMerge).not.toBe(CATALOGS.en.readyToMerge)
    expect(ptBR.readyToMerge).toContain("✅")
    expect(ptBR.notReadyToMerge).not.toBe(CATALOGS.en.notReadyToMerge)
    expect(ptBR.notReadyToMerge).toContain("🚧")
    expect(ptBR.reviewMidCiInstruction).not.toBe(CATALOGS.en.reviewMidCiInstruction)
    expect(ptBR.reviewKeepsWatching).not.toBe(CATALOGS.en.reviewKeepsWatching)
    expect(ptBR.reviewAddressInstruction).not.toBe(CATALOGS.en.reviewAddressInstruction)
  })
})
