import { describe, expect, it } from "bun:test"
import { CATALOGS, type Locale } from "./i18n.ts"
import { PANEL_PHASE_KEYS, type PanelPhaseKey, type PanelTone } from "./panel-types.ts"
import { buildChrome, buildPanelSnapshot, type PanelDeps, panelLocale } from "./panel-view.ts"
import { externalChecks, prReadiness } from "./render.ts"
import type {
  CiReport,
  CommitSha,
  PrCheck,
  PrInfo,
  ReviewDelta,
  ReviewSnapshot,
  ReviewThread,
  SessionId,
  SessionState,
  Watch,
  WatchPhase,
  WorkflowRun,
} from "./types.ts"

const EN = CATALOGS.en
const PT = CATALOGS["pt-BR"]

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 1,
    name: "ci",
    workflowName: "CI",
    status: "completed",
    conclusion: "success",
    url: "https://github.com/o/r/actions/runs/1",
    branch: "feat/panel",
    ...overrides,
  }
}

function makePr(overrides: Partial<PrInfo> = {}): PrInfo {
  return {
    number: 3603,
    title: "dashboard divergence",
    url: "https://github.com/o/r/pull/3603",
    isDraft: false,
    state: "OPEN",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    commitCount: 3,
    checks: [],
    ...overrides,
  }
}

function makeReport(overrides: Partial<CiReport> = {}): CiReport {
  return {
    sha: "abcdef1234567890" as CommitSha,
    branch: "feat/panel",
    repo: "github.com/o/r",
    sourceKind: "session",
    directory: "/repo",
    runs: [makeRun()],
    failedLogs: [],
    pr: makePr(),
    ruleFailures: [],
    review: null,
    ...overrides,
  }
}

function threads(unresolved: number, resolved = 0): readonly ReviewThread[] {
  const build = (index: number, isResolved: boolean): ReviewThread => ({
    id: `T${isResolved ? "r" : "u"}${index}`,
    isResolved,
    isOutdated: false,
    comments: [],
  })
  return [
    ...Array.from({ length: unresolved }, (_, index) => build(index, false)),
    ...Array.from({ length: resolved }, (_, index) => build(index, true)),
  ]
}

function makeSnapshot(overrides: Partial<ReviewSnapshot> = {}): ReviewSnapshot {
  return {
    prNumber: 3603,
    prState: "OPEN",
    merged: false,
    reviewDecision: null,
    mergeStateStatus: "CLEAN",
    threads: [],
    reviews: [],
    comments: [],
    fetchedAt: 1,
    ...overrides,
  }
}

const EMPTY_DELTA: ReviewDelta = {
  newComments: [],
  newReviews: [],
  threadsResolved: [],
  threadsUnresolved: [],
  decisionChange: null,
  mergeStateChange: null,
  unresolved: { from: 0, to: 0 },
}

function makeWatch(overrides: Partial<Watch> = {}): Watch {
  return {
    sha: "abcdef1234567890" as CommitSha,
    branch: "feat/panel",
    repo: "github.com/o/r",
    repoUrl: "https://github.com/o/r",
    directory: "/home/u/workspace/opencode-ci-loop",
    sourceKind: "session",
    startedAt: 1_000,
    phase: { kind: "waiting" },
    ...overrides,
  }
}

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  const watches = overrides.watches ?? []
  return {
    sessionID: "ses_06f7abc" as SessionId,
    enabled: true,
    directory: "/home/u/workspace/opencode-ci-loop",
    ...overrides,
    watches,
    watch: watches[0] ?? null,
  }
}

function makeDeps(overrides: Partial<PanelDeps> = {}): PanelDeps {
  return { language: "en", locales: new Map(), titles: new Map(), ...overrides }
}

/** Single-session, single-watch snapshot — the shape most assertions below need. */
function oneWatch(phase: WatchPhase, deps: PanelDeps = makeDeps()) {
  const session = makeSession({ watches: [makeWatch({ phase })] })
  const snapshot = buildPanelSnapshot([session], deps)
  const panelSession = snapshot.sessions[0]
  if (!panelSession) throw new Error("expected one session")
  const watch = panelSession.watches[0]
  if (!watch) throw new Error("expected one watch")
  return { snapshot, session: panelSession, watch }
}

describe("panelLocale", () => {
  it("uses an explicit config language over any detected locale", () => {
    const sessions = [makeSession({ watches: [makeWatch()] })]
    const locales = new Map<SessionId, Locale>([["ses_06f7abc" as SessionId, "pt-BR"]])
    expect(panelLocale("en", sessions, locales)).toBe("en")
    expect(panelLocale("pt-BR", sessions, new Map())).toBe("pt-BR")
  })

  it("on auto, follows the session owning the most recently started watch", () => {
    const older = makeSession({
      sessionID: "ses_a" as SessionId,
      watches: [makeWatch({ startedAt: 1_000 })],
    })
    const newer = makeSession({
      sessionID: "ses_b" as SessionId,
      watches: [makeWatch({ startedAt: 9_000 })],
    })
    const locales = new Map<SessionId, Locale>([
      ["ses_a" as SessionId, "en"],
      ["ses_b" as SessionId, "pt-BR"],
    ])
    expect(panelLocale("auto", [older, newer], locales)).toBe("pt-BR")
    expect(panelLocale("auto", [newer, older], locales)).toBe("pt-BR")
  })

  it("breaks ties by sessionID ascending", () => {
    const first = makeSession({
      sessionID: "ses_a" as SessionId,
      watches: [makeWatch({ startedAt: 5_000 })],
    })
    const second = makeSession({
      sessionID: "ses_b" as SessionId,
      watches: [makeWatch({ startedAt: 5_000 })],
    })
    const locales = new Map<SessionId, Locale>([
      ["ses_a" as SessionId, "pt-BR"],
      ["ses_b" as SessionId, "en"],
    ])
    expect(panelLocale("auto", [first, second], locales)).toBe("pt-BR")
    expect(panelLocale("auto", [second, first], locales)).toBe("pt-BR")
  })

  it("falls back to en with no watches and no cached locale", () => {
    expect(panelLocale("auto", [], new Map())).toBe("en")
    const withWatch = [makeSession({ watches: [makeWatch()] })]
    expect(panelLocale("auto", withWatch, new Map())).toBe("en")
    const watchless = [makeSession({ sessionID: "ses_a" as SessionId })]
    const locales = new Map<SessionId, Locale>([["ses_a" as SessionId, "pt-BR"]])
    expect(panelLocale("auto", watchless, locales)).toBe("en")
  })
})

describe("buildChrome", () => {
  it("sources every chrome field from the catalog", () => {
    expect(buildChrome(EN)).toEqual({
      pageTitle: EN.panelPageTitle,
      emptyWaiting: EN.panelEmptyWaiting,
      noMatches: EN.panelNoMatches,
      searchPlaceholder: EN.panelSearchPlaceholder,
      filtersLabel: EN.panelFiltersLabel,
      filterEnabledAll: EN.panelFilterEnabledAll,
      filterEnabledOn: EN.panelFilterEnabledOn,
      filterEnabledOff: EN.panelFilterEnabledOff,
      watchOn: EN.panelWatchOn,
      watchOff: EN.panelWatchOff,
      clearFilters: EN.panelClearFilters,
      hiddenTemplate: EN.panelHiddenTemplate,
      phaseChips: {
        waiting: EN.panelPhaseChip("waiting"),
        running: EN.panelPhaseChip("running"),
        "done-green": EN.panelPhaseChip("done-green"),
        "done-failed": EN.panelPhaseChip("done-failed"),
        reviewing: EN.panelPhaseChip("reviewing"),
        "review-ended": EN.panelPhaseChip("review-ended"),
        "timed-out": EN.panelPhaseChip("timed-out"),
        error: EN.panelPhaseChip("error"),
      },
    })
  })

  it("localizes the chrome for pt-BR", () => {
    const chrome = buildChrome(PT)
    expect(chrome.noMatches).toBe(PT.panelNoMatches)
    expect(chrome.phaseChips["done-failed"]).toBe(PT.panelPhaseChip("done-failed"))
    expect(chrome.noMatches).not.toBe(EN.panelNoMatches)
  })

  it("follows the chrome locale of the most recently started watch", () => {
    const older = makeSession({
      sessionID: "ses_a" as SessionId,
      watches: [makeWatch({ startedAt: 1 })],
    })
    const newer = makeSession({
      sessionID: "ses_b" as SessionId,
      watches: [makeWatch({ startedAt: 2 })],
    })
    const deps = makeDeps({
      language: "auto",
      locales: new Map<SessionId, Locale>([
        ["ses_a" as SessionId, "en"],
        ["ses_b" as SessionId, "pt-BR"],
      ]),
    })
    expect(buildPanelSnapshot([older, newer], deps).chrome.pageTitle).toBe(PT.panelPageTitle)
    expect(buildPanelSnapshot([older, newer], deps).chrome.noMatches).toBe(PT.panelNoMatches)
  })
})

describe("buildPanelSnapshot — readiness (S1)", () => {
  const blockedReport = makeReport({
    pr: makePr({ mergeStateStatus: "BLOCKED" }),
    review: makeSnapshot({ mergeStateStatus: "BLOCKED", threads: threads(5, 2) }),
  })

  it("renders a BLOCKED PR with unresolved reviews as not ready with BOTH blockers", () => {
    const { watch } = oneWatch({ kind: "done", report: blockedReport })
    expect(watch.pr).not.toBeNull()
    expect(watch.pr?.ready).toBe(false)
    expect(watch.pr?.verdictLabel).toBe(EN.notReadyToMerge)
    expect(watch.pr?.blockers).toEqual([EN.blockerBranchProtection, EN.blockerUnresolvedConversations(5)])
  })

  it("never emits the raw labels 'ready for review' or 'mergeable'", () => {
    const { watch } = oneWatch({ kind: "done", report: blockedReport })
    const json = JSON.stringify(watch)
    expect(json).not.toContain("ready for review")
    expect(json).not.toContain("mergeable")
    expect(json).not.toContain("MERGEABLE")
    expect(json).not.toContain("BLOCKED")
    expect(json).not.toContain("APPROVED")
    expect(json).not.toContain("OPEN")
    expect(Object.keys(watch.pr ?? {}).sort()).toEqual([
      "blockers",
      "draftLabel",
      "number",
      "ready",
      "title",
      "url",
      "verdictLabel",
    ])
  })

  it("emits exactly prReadiness().blockers, in order, for the session locale", () => {
    const expected = prReadiness(makePr({ mergeStateStatus: "BLOCKED" }), true, 5, "en")
    const { watch } = oneWatch({ kind: "done", report: blockedReport })
    expect(watch.pr?.blockers).toEqual(expected.blockers)
    expect(watch.pr?.ready).toBe(expected.ready)
  })

  it("keeps a draft label when the PR is actually a draft", () => {
    const draft = makeReport({ pr: makePr({ isDraft: true, mergeStateStatus: "DRAFT" }) })
    expect(oneWatch({ kind: "done", report: draft }).watch.pr?.draftLabel).toBe(EN.panelDraft)
    expect(oneWatch({ kind: "done", report: makeReport() }).watch.pr?.draftLabel).toBeNull()
  })

  it("marks a clean PR as ready with the ready verdict and no blockers", () => {
    const { watch } = oneWatch({ kind: "done", report: makeReport() })
    expect(watch.pr?.ready).toBe(true)
    expect(watch.pr?.verdictLabel).toBe(EN.readyToMerge)
    expect(watch.pr?.blockers).toEqual([])
  })

  it("emits a null pr when the report has no PR", () => {
    const { watch } = oneWatch({ kind: "done", report: makeReport({ pr: null }) })
    expect(watch.pr).toBeNull()
  })
})

describe("buildPanelSnapshot — reviewing phase (S2, S3)", () => {
  const staleReport = makeReport({
    runs: [makeRun({ workflowName: "CI" }), makeRun({ id: 2, workflowName: "lint" })],
    pr: makePr({ mergeStateStatus: "CLEAN", reviewDecision: "APPROVED" }),
  })
  const freshSnapshot = makeSnapshot({
    mergeStateStatus: "BLOCKED",
    reviewDecision: "REVIEW_REQUIRED",
    threads: threads(5, 1),
  })
  const reviewing: WatchPhase = {
    kind: "reviewing",
    report: staleReport,
    snapshot: freshSnapshot,
    delta: EMPTY_DELTA,
  }

  it("keeps the CI runs from phase.report on the done→reviewing transition", () => {
    const done = oneWatch({ kind: "done", report: staleReport }).watch
    const inReview = oneWatch(reviewing).watch
    expect(done.runs.map((run) => run.name)).toEqual(["CI", "lint"])
    expect(inReview.runs).toEqual(done.runs)
  })

  it("computes readiness from the fresher snapshot mergeStateStatus/reviewDecision", () => {
    // The stale report.pr alone would say "ready" — proving the fixture exercises the freshness rule.
    expect(prReadiness(staleReport.pr ?? makePr(), true, 0, "en").ready).toBe(true)
    const { watch } = oneWatch(reviewing)
    expect(watch.pr?.ready).toBe(false)
    expect(watch.pr?.blockers).toEqual([
      EN.blockerBranchProtection,
      EN.blockerReviewRequired,
      EN.blockerUnresolvedConversations(5),
    ])
    expect(watch.phaseLabel).toBe(EN.panelWatchingReviews(5))
  })

  it("produces the same verdict and blockers as the done phase for the same PR", () => {
    const settled = makeReport({
      runs: staleReport.runs,
      pr: makePr({ mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" }),
      review: freshSnapshot,
    })
    expect(oneWatch(reviewing).watch.pr).toEqual(oneWatch({ kind: "done", report: settled }).watch.pr)
  })
})

describe("buildPanelSnapshot — review-ended (S4)", () => {
  it("carries the PR, the runs and a localized end-reason label", () => {
    const { watch } = oneWatch({
      kind: "review-ended",
      report: makeReport({ runs: [makeRun({ workflowName: "CI" })] }),
      snapshot: makeSnapshot(),
      delta: EMPTY_DELTA,
      reason: "idle-timeout",
    })
    expect(watch.phaseKey).toBe("review-ended")
    expect(watch.tone).toBe("ok")
    expect(watch.phaseLabel).toBe(EN.panelReviewEnded("idle-timeout"))
    expect(watch.runs.map((run) => run.name)).toEqual(["CI"])
    expect(watch.pr?.number).toBe(3603)
  })
})

describe("buildPanelSnapshot — external checks (S5)", () => {
  const netlify: PrCheck = {
    name: "netlify/deploy",
    workflowName: null,
    status: "pending",
    state: "PENDING",
    url: "https://netlify.app/deploy/1",
  }
  const duplicate: PrCheck = {
    name: "CI / build",
    workflowName: "CI",
    status: "failing",
    state: "FAILURE",
    url: null,
  }
  const codecov: PrCheck = {
    name: "codecov/patch",
    workflowName: null,
    status: "failing",
    state: "FAILURE",
    url: null,
  }
  const passing: PrCheck = {
    name: "vercel",
    workflowName: null,
    status: "passing",
    state: "SUCCESS",
    url: null,
  }
  const report = makeReport({
    runs: [makeRun({ workflowName: "CI" })],
    pr: makePr({ checks: [netlify, duplicate, codecov, passing] }),
  })

  it("surfaces a pending external check with a null workflowName", () => {
    const { watch } = oneWatch({ kind: "done", report })
    expect(watch.checks).toContainEqual({
      name: "netlify/deploy",
      url: "https://netlify.app/deploy/1",
      state: "PENDING",
      failing: false,
    })
  })

  it("hides checks already listed as workflow runs", () => {
    const { watch } = oneWatch({ kind: "done", report })
    expect(watch.checks.map((check) => check.name)).not.toContain("CI / build")
    expect(watch.checks.map((check) => check.name)).not.toContain("vercel")
  })

  it("matches externalChecks() exactly", () => {
    const { watch } = oneWatch({ kind: "done", report })
    expect(watch.checks).toEqual(
      externalChecks(report).map((check) => ({
        name: check.name,
        url: check.url,
        state: check.state,
        failing: check.status === "failing",
      })),
    )
    expect(watch.checks.map((check) => check.failing)).toEqual([false, true])
  })
})

describe("buildPanelSnapshot — locale (S6)", () => {
  const blocked = makeReport({ pr: makePr({ mergeStateStatus: "BLOCKED" }) })

  it("renders per-session blockers in that session's locale", () => {
    const deps = makeDeps({
      language: "auto",
      locales: new Map<SessionId, Locale>([["ses_06f7abc" as SessionId, "pt-BR"]]),
    })
    const { watch } = oneWatch({ kind: "done", report: blocked }, deps)
    expect(watch.pr?.blockers).toEqual([PT.blockerBranchProtection])
    expect(watch.pr?.verdictLabel).toBe(PT.notReadyToMerge)
    expect(watch.phaseLabel).toBe(PT.panelPhaseCiGreen)
  })

  it("renders two sessions in two different locales in one snapshot", () => {
    const english = makeSession({
      sessionID: "ses_en" as SessionId,
      watches: [makeWatch({ startedAt: 2, phase: { kind: "done", report: blocked } })],
    })
    const brazilian = makeSession({
      sessionID: "ses_pt" as SessionId,
      watches: [makeWatch({ startedAt: 1, phase: { kind: "done", report: blocked } })],
    })
    const deps = makeDeps({
      language: "auto",
      locales: new Map<SessionId, Locale>([
        ["ses_en" as SessionId, "en"],
        ["ses_pt" as SessionId, "pt-BR"],
      ]),
    })
    const snapshot = buildPanelSnapshot([english, brazilian], deps)
    expect(snapshot.sessions[0]?.watches[0]?.pr?.blockers).toEqual([EN.blockerBranchProtection])
    expect(snapshot.sessions[1]?.watches[0]?.pr?.blockers).toEqual([PT.blockerBranchProtection])
    // Chrome follows the newest watch (ses_en), while ses_pt still renders in pt-BR.
    expect(snapshot.chrome.noMatches).toBe(EN.panelNoMatches)
  })
})

describe("buildPanelSnapshot — title (S8, S10)", () => {
  const xss = '<img src=x onerror=alert(1)> & "quoted"'

  it("carries the title raw and unescaped", () => {
    const deps = makeDeps({ titles: new Map([["ses_06f7abc" as SessionId, xss]]) })
    const { session } = oneWatch({ kind: "waiting" }, deps)
    expect(session.title).toBe(xss)
    expect(JSON.stringify(session)).not.toContain("&amp;")
    expect(JSON.stringify(session)).not.toContain("&lt;")
  })

  it("emits title: null when no title is cached", () => {
    expect(oneWatch({ kind: "waiting" }).session.title).toBeNull()
  })

  it("carries the session identity, the project label and the raw directory", () => {
    const { session } = oneWatch({ kind: "waiting" })
    expect(session.sessionID).toBe("ses_06f7abc")
    expect(session.projectLabel).toBe("opencode-ci-loop")
    expect(session.directory).toBe("/home/u/workspace/opencode-ci-loop")
    expect(session.enabled).toBe(true)
  })

  it("emits a null project label when the session has no directory", () => {
    const snapshot = buildPanelSnapshot([makeSession({ directory: null })], makeDeps())
    expect(snapshot.sessions[0]?.projectLabel).toBeNull()
    expect(snapshot.sessions[0]?.directory).toBeNull()
  })
})

describe("buildPanelSnapshot — watch meta", () => {
  it("joins repo, branch, source label and the short sha", () => {
    const { watch } = oneWatch({ kind: "waiting" })
    expect(watch.meta).toBe("github.com/o/r · feat/panel · current branch of this session · abcdef12")
    expect(watch.key).toBe("github.com/o/r\u0000feat/panel")
  })
})

describe("buildPanelSnapshot — searchText (S11)", () => {
  const deps = makeDeps({ titles: new Map([["ses_06f7abc" as SessionId, "Fix the CI Loop"]]) })

  it.each([
    ["fix the ci loop"],
    ["ses_06f7abc"],
    ["opencode-ci-loop"],
    ["github.com/o/r"],
    ["feat/panel"],
    ["#3603"],
    ["dashboard divergence"],
  ])("includes %s in the watch haystack, lowercased", (needle) => {
    const { watch } = oneWatch({ kind: "done", report: makeReport() }, deps)
    expect(watch.searchText).toContain(needle)
    expect(watch.searchText).toBe(watch.searchText.toLowerCase())
  })

  it("includes only session fields in a watchless session's haystack", () => {
    const snapshot = buildPanelSnapshot([makeSession()], deps)
    expect(snapshot.sessions[0]?.searchText).toBe(
      "fix the ci loop ses_06f7abc /home/u/workspace/opencode-ci-loop",
    )
  })

  it("omits a missing title and directory from the haystack", () => {
    const snapshot = buildPanelSnapshot([makeSession({ directory: null })], makeDeps())
    expect(snapshot.sessions[0]?.searchText).toBe("ses_06f7abc")
  })
})

describe("buildPanelSnapshot — phaseKey", () => {
  const report = makeReport()
  const cases: readonly (readonly [WatchPhase, PanelPhaseKey, PanelTone, string])[] = [
    [{ kind: "waiting" }, "waiting", "info", EN.panelPhaseWaiting],
    [{ kind: "running", runs: [makeRun()] }, "running", "info", EN.panelPhaseRunning],
    [{ kind: "done", report }, "done-green", "ok", EN.panelPhaseCiGreen],
    [
      { kind: "reviewing", report, snapshot: makeSnapshot(), delta: EMPTY_DELTA },
      "reviewing",
      "info",
      EN.panelWatchingReviews(0),
    ],
    [
      { kind: "review-ended", report, snapshot: makeSnapshot(), delta: EMPTY_DELTA, reason: "merged" },
      "review-ended",
      "ok",
      EN.panelReviewEnded("merged"),
    ],
    [{ kind: "timed-out", runs: [makeRun()] }, "timed-out", "warn", EN.panelPhaseTimedOut],
    [{ kind: "error", message: "gh exploded" }, "error", "fail", EN.panelPhaseError("gh exploded")],
  ]

  it.each(cases)("maps every WatchPhase kind to its PanelPhaseKey", (phase, key, tone, label) => {
    const { watch } = oneWatch(phase)
    expect(watch.phaseKey).toBe(key)
    expect(watch.tone).toBe(tone)
    expect(watch.phaseLabel).toBe(label)
  })

  it("covers every declared panel phase key", () => {
    expect(new Set(cases.map(([, key]) => key)).size).toBe(PANEL_PHASE_KEYS.length - 1)
  })

  it("splits done into done-green / done-failed via isReportClean", () => {
    const failed = makeReport({ runs: [makeRun({ conclusion: "failure" })] })
    const green = oneWatch({ kind: "done", report: makeReport() }).watch
    const red = oneWatch({ kind: "done", report: failed }).watch
    expect(green.phaseKey).toBe("done-green")
    expect(green.tone).toBe("ok")
    expect(red.phaseKey).toBe("done-failed")
    expect(red.tone).toBe("fail")
    expect(red.phaseLabel).toBe(EN.panelPhaseCiFailed)
    expect(red.pr?.blockers).toEqual([EN.blockerCiFailing])
  })

  it("carries the failure log tails of the report", () => {
    const report = makeReport({
      runs: [makeRun({ conclusion: "failure" })],
      failedLogs: [{ runId: 1, runName: "CI", logTail: "boom <&>" }],
    })
    const { watch } = oneWatch({ kind: "done", report })
    expect(watch.failures).toEqual([{ runName: "CI", logTail: "boom <&>" }])
  })

  it("carries the in-flight runs of the running and timed-out phases", () => {
    const runs = [makeRun({ status: "in_progress", conclusion: null })]
    expect(oneWatch({ kind: "running", runs }).watch.runs).toEqual([
      { name: "CI", url: runs[0]?.url ?? "", status: "in_progress", state: "in_progress" },
    ])
    expect(oneWatch({ kind: "timed-out", runs }).watch.runs).toHaveLength(1)
    expect(oneWatch({ kind: "waiting" }).watch.runs).toEqual([])
    expect(oneWatch({ kind: "error", message: "x" }).watch.checks).toEqual([])
  })
})

describe("buildPanelSnapshot — failed", () => {
  const clean = makeReport()
  const ciFailed = makeReport({ runs: [makeRun({ conclusion: "failure" })] })
  const prBlockedOnly = makeReport({ pr: makePr({ mergeStateStatus: "BLOCKED", reviewDecision: null }) })
  const reviewing = (report: CiReport): WatchPhase => ({
    kind: "reviewing",
    report,
    snapshot: makeSnapshot({ threads: threads(2), mergeStateStatus: "BLOCKED" }),
    delta: EMPTY_DELTA,
  })
  const ended = (report: CiReport): WatchPhase => ({
    kind: "review-ended",
    report,
    snapshot: makeSnapshot(),
    delta: EMPTY_DELTA,
    reason: "merged",
  })
  const cases: readonly (readonly [string, WatchPhase, boolean])[] = [
    ["waiting", { kind: "waiting" }, false],
    ["running", { kind: "running", runs: [makeRun({ status: "in_progress", conclusion: null })] }, false],
    ["timed-out", { kind: "timed-out", runs: [makeRun({ status: "in_progress", conclusion: null })] }, false],
    ["error", { kind: "error", message: "gh exploded" }, true],
    ["done clean", { kind: "done", report: clean }, false],
    ["done CI failed", { kind: "done", report: ciFailed }, true],
    ["done PR-only blocker", { kind: "done", report: prBlockedOnly }, false],
    ["reviewing clean CI with unresolved threads", reviewing(clean), false],
    ["reviewing failed CI", reviewing(ciFailed), true],
    ["review-ended clean", ended(clean), false],
    ["review-ended failed CI", ended(ciFailed), true],
  ]

  it.each(cases)("%s → failed=%p", (_label, phase, failed) => {
    expect(oneWatch(phase).watch.failed).toBe(failed)
  })

  it("keeps the stored failure visible on a paused session", () => {
    const session = makeSession({
      enabled: false,
      watches: [makeWatch({ phase: { kind: "done", report: ciFailed } })],
    })
    expect(buildPanelSnapshot([session], makeDeps()).sessions[0]?.watches[0]?.failed).toBe(true)
  })
})

describe("buildPanelSnapshot — viewer locale override", () => {
  const blocked = makeReport({ pr: makePr({ mergeStateStatus: "BLOCKED" }) })
  const sessions = [
    makeSession({
      sessionID: "ses_en" as SessionId,
      watches: [makeWatch({ startedAt: 2, phase: { kind: "done", report: blocked } })],
    }),
    makeSession({
      sessionID: "ses_pt" as SessionId,
      watches: [makeWatch({ startedAt: 1, phase: { kind: "done", report: blocked } })],
    }),
  ]
  const locales = new Map<SessionId, Locale>([
    ["ses_en" as SessionId, "en"],
    ["ses_pt" as SessionId, "pt-BR"],
  ])

  it.each(["en", "pt-BR"] as const)("renders chrome and every session row in %s", (locale) => {
    const snapshot = buildPanelSnapshot(sessions, makeDeps({ language: "auto", locales, locale }))
    expect(snapshot.chrome.noMatches).toBe(CATALOGS[locale].panelNoMatches)
    expect(snapshot.sessions.map((session) => session.watches[0]?.pr?.blockers)).toEqual([
      [CATALOGS[locale].blockerBranchProtection],
      [CATALOGS[locale].blockerBranchProtection],
    ])
  })

  it("leaves per-session localization intact without an override", () => {
    const snapshot = buildPanelSnapshot(sessions, makeDeps({ language: "auto", locales }))
    expect(snapshot.sessions.map((session) => session.watches[0]?.pr?.blockers)).toEqual([
      [EN.blockerBranchProtection],
      [PT.blockerBranchProtection],
    ])
  })
})
