import type { HostClient } from "@openchamber/sdk"
import { mountBadge } from "@openchamber/sdk/ui"
import type { PanelCheck, PanelRun, PanelWatch } from "../../panel-types.ts"
import type { GuestLocale } from "../locale.ts"
import { node, syncChildren } from "./dom-list.ts"
import { externalLink } from "./external-link.ts"

type LinkHost = Pick<HostClient, "openUrl">
type EvidenceRow = {
  readonly element: HTMLElement
  readonly link: ReturnType<typeof externalLink>
  readonly state: HTMLElement
}
type FailureRow = {
  readonly element: HTMLDetailsElement
  readonly summary: HTMLElement
  readonly log: HTMLElement
}

function evidenceRow(host: LinkHost, locale: GuestLocale): EvidenceRow {
  const element = node("li", "ci-evidence")
  const link = externalLink(host, locale)
  const state = node("span", "ci-evidence-state")
  element.append(link.element, state)
  return { element, link, state }
}

function runTone(run: PanelRun): string {
  if (run.status !== "completed") return "info"
  if (run.state === "success") return "success"
  if (["failure", "timed_out", "startup_failure", "failed"].includes(run.state)) return "error"
  return "neutral"
}

function checkTone(check: PanelCheck): string {
  if (check.failing) return "error"
  if (check.state === "success") return "success"
  if (check.state === "pending" || check.state === "queued") return "info"
  return "neutral"
}

export class WatchView {
  readonly element = node("article", "ci-watch")
  private readonly meta = node("p", "ci-watch-meta")
  private readonly phaseRoot = node("div", "ci-phase")
  private readonly failureMarker = node("span", "ci-failure-marker")
  private readonly runsGroup = node("section", "ci-evidence-group")
  private readonly checksGroup = node("section", "ci-evidence-group")
  private readonly runsRoot = node("ul", "ci-evidence-list")
  private readonly checksRoot = node("ul", "ci-evidence-list")
  private readonly failuresRoot = node("div", "ci-failures")
  private readonly prRoot = node("section", "ci-pr")
  private readonly prLink: ReturnType<typeof externalLink>
  private readonly verdict = node("p", "ci-verdict")
  private readonly draft = node("span", "ci-draft")
  private readonly blockers = node("ul", "ci-blockers")
  private readonly phase: ReturnType<typeof mountBadge>
  private readonly runs = new Map<string, EvidenceRow>()
  private readonly checks = new Map<string, EvidenceRow>()
  private readonly failures = new Map<string, FailureRow>()
  private readonly blockerRows = new Map<number, HTMLLIElement>()

  constructor(
    private readonly host: LinkHost,
    private readonly locale: GuestLocale,
  ) {
    const badgeRoot = node("span", "ci-phase-badge")
    this.phaseRoot.append(badgeRoot, this.failureMarker)
    this.phase = mountBadge(badgeRoot, { label: "", tone: "neutral" })
    const runsTitle = node("h3", "ci-evidence-title")
    const checksTitle = node("h3", "ci-evidence-title")
    runsTitle.textContent = locale === "pt-BR" ? "Execuções" : "Runs"
    checksTitle.textContent = locale === "pt-BR" ? "Checks externos" : "External checks"
    this.runsGroup.append(runsTitle, this.runsRoot)
    this.checksGroup.append(checksTitle, this.checksRoot)
    const prLine = node("div", "ci-pr-line")
    const prLabel = node("span", "ci-pr-label")
    prLabel.textContent = "PR"
    this.prLink = externalLink(host, locale)
    prLine.append(prLabel, this.prLink.element, this.draft)
    this.prRoot.append(prLine, this.verdict, this.blockers)
    this.element.append(
      this.meta,
      this.phaseRoot,
      this.runsGroup,
      this.checksGroup,
      this.failuresRoot,
      this.prRoot,
    )
  }

  update(watch: PanelWatch): void {
    this.meta.textContent = watch.meta
    this.phase.update({ label: watch.phaseLabel, tone: this.phaseTone(watch.tone) })
    this.failureMarker.hidden = !watch.failed
    this.failureMarker.textContent = this.locale === "pt-BR" ? "Falha no CI" : "CI failed"
    this.runsGroup.hidden = watch.runs.length === 0
    this.checksGroup.hidden = watch.checks.length === 0
    const runNodes: HTMLElement[] = []
    const liveRuns = new Set<string>()
    for (const [index, run] of watch.runs.entries()) {
      const key = `${run.url}\0${run.name}\0${index}`
      liveRuns.add(key)
      let row = this.runs.get(key)
      if (!row) {
        row = evidenceRow(this.host, this.locale)
        this.runs.set(key, row)
      }
      row.link.update(run.name, run.url)
      row.state.textContent = run.status === run.state ? run.state : `${run.status} · ${run.state}`
      row.state.dataset["tone"] = runTone(run)
      runNodes.push(row.element)
    }
    for (const key of this.runs.keys()) if (!liveRuns.has(key)) this.runs.delete(key)
    syncChildren(this.runsRoot, runNodes)

    const checkNodes: HTMLElement[] = []
    const liveChecks = new Set<string>()
    for (const [index, check] of watch.checks.entries()) {
      const key = `${check.url ?? ""}\0${check.name}\0${index}`
      liveChecks.add(key)
      let row = this.checks.get(key)
      if (!row) {
        row = evidenceRow(this.host, this.locale)
        this.checks.set(key, row)
      }
      row.link.update(check.name, check.url)
      row.state.textContent = check.state
      row.state.dataset["tone"] = checkTone(check)
      checkNodes.push(row.element)
    }
    for (const key of this.checks.keys()) if (!liveChecks.has(key)) this.checks.delete(key)
    syncChildren(this.checksRoot, checkNodes)

    const failureNodes: HTMLElement[] = []
    const liveFailures = new Set<string>()
    for (const [index, failure] of watch.failures.entries()) {
      const key = `${failure.runName}\0${index}`
      liveFailures.add(key)
      let row = this.failures.get(key)
      if (!row) {
        const element = node("details", "ci-failure")
        const summary = node("summary", "ci-failure-name")
        const log = node("pre", "ci-log")
        element.append(summary, log)
        row = { element, summary, log }
        this.failures.set(key, row)
      }
      row.summary.textContent = failure.runName
      row.log.textContent = failure.logTail
      failureNodes.push(row.element)
    }
    for (const key of this.failures.keys()) if (!liveFailures.has(key)) this.failures.delete(key)
    syncChildren(this.failuresRoot, failureNodes)
    this.updatePr(watch)
  }

  private updatePr(watch: PanelWatch): void {
    const pr = watch.pr
    this.prRoot.hidden = pr === null
    if (pr === null) return
    this.prLink.update(`#${pr.number} ${pr.title}`, pr.url)
    this.verdict.textContent = pr.verdictLabel
    this.verdict.dataset["tone"] = pr.ready ? "success" : "warning"
    this.draft.hidden = pr.draftLabel === null
    this.draft.textContent = pr.draftLabel
    const rows: HTMLElement[] = []
    for (const [index, blocker] of pr.blockers.entries()) {
      let item = this.blockerRows.get(index)
      if (!item) {
        item = node("li", "ci-blocker")
        this.blockerRows.set(index, item)
      }
      item.textContent = blocker
      rows.push(item)
    }
    for (const key of this.blockerRows.keys()) if (key >= rows.length) this.blockerRows.delete(key)
    syncChildren(this.blockers, rows)
    this.blockers.hidden = rows.length === 0
  }

  private phaseTone(tone: PanelWatch["tone"]): "info" | "success" | "error" | "warning" {
    switch (tone) {
      case "info":
        return "info"
      case "ok":
        return "success"
      case "fail":
        return "error"
      case "warn":
        return "warning"
      default:
        return assertNever(tone)
    }
  }

  dispose(): void {
    this.phase.dispose()
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled panel tone ${value}`)
}
