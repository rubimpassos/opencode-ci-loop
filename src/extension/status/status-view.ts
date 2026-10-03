import type { HostClient } from "@openchamber/sdk"
import { mountBadge, mountButton, mountSwitch, type Tone } from "@openchamber/sdk/ui"
import type { PanelTone } from "../../panel-types.ts"
import type { PanelBinding } from "../binding.ts"
import { describeConnection } from "../connection-view.ts"
import { createStatusController, type StatusModel } from "./status-controller.ts"
import { failureText, runCounts, STATUS_LABELS } from "./status-copy.ts"
import { trackStatusHeight } from "./status-height.ts"
import { STATUS_CSS } from "./status-styles.ts"

function assertNever(value: never): never {
  throw new Error(`unhandled CI tone ${JSON.stringify(value)}`)
}

function badgeTone(tone: PanelTone): Tone {
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

const plainLabel = (label: string): string => label.replace(/^[^\p{L}\p{N}]+/u, "")

const element = (name: keyof HTMLElementTagNameMap, className: string): HTMLElement => {
  const node = document.createElement(name)
  node.className = className
  return node
}

/** The host owns the section header. This guest owns only the open chat's readout and control. */
export function mountStatusView(
  binding: PanelBinding,
  host: Pick<HostClient, "onSession" | "setHeight">,
  root: HTMLElement,
): () => void {
  const style = document.createElement("style")
  style.textContent = STATUS_CSS
  document.head.append(style)

  const page = element("main", "ci-status")
  const switchSlot = element("div", "ci-status__switch")
  const summary = element("div", "ci-status__summary")
  summary.setAttribute("aria-live", "polite")
  const readout = element("div", "ci-status__readout")
  const phaseSlot = element("div", "ci-status__phase")
  const metric = element("span", "ci-status__metric")
  readout.append(phaseSlot, metric)
  const note = element("p", "ci-status__note")
  const pr = element("p", "ci-status__pr")
  const blocker = element("p", "ci-status__blocker")
  const connection = element("p", "ci-status__connection")
  connection.setAttribute("role", "status")
  const error = element("div", "ci-status__error")
  error.setAttribute("role", "alert")
  const errorText = element("span", "ci-status__error-text")
  const retrySlot = element("span", "ci-status__retry")
  error.append(errorText, retrySlot)
  summary.append(readout, note, pr, blocker)
  page.append(switchSlot, summary, connection, error)
  root.replaceChildren(page)

  let controller: ReturnType<typeof createStatusController> | null = null
  const toggle = mountSwitch(switchSlot, {
    label: STATUS_LABELS.en.watch,
    description: STATUS_LABELS.en.description,
    checked: false,
    disabled: true,
    onChange: (checked) => controller?.toggle(checked),
  })
  const phase = mountBadge(phaseSlot, { label: "", tone: "neutral" })
  const retry = mountButton(retrySlot, {
    label: STATUS_LABELS.en.retry,
    variant: "ghost",
    size: "xs",
    onClick: () => controller?.retry(),
  })
  const height = trackStatusHeight(
    () => page.getBoundingClientRect().height,
    (value) => host.setHeight(value),
    (fit) => {
      const observer = new ResizeObserver(fit)
      observer.observe(page)
      return () => observer.disconnect()
    },
  )

  const render = (model: StatusModel): void => {
    const labels = STATUS_LABELS[model.state.locale]
    const { watch, sessionID } = model
    const fresh =
      !model.state.stale &&
      (model.state.connection.kind === "live" || model.state.connection.kind === "polling")
    switchSlot.hidden = sessionID === null
    toggle.update({
      label: labels.watch,
      description: labels.description,
      checked: model.enabled ?? false,
      disabled: !fresh || model.enabled === null || model.pending,
    })

    readout.hidden = sessionID === null || watch === null
    if (watch) {
      phase.update({ label: plainLabel(watch.phaseLabel), tone: badgeTone(watch.tone) })
      const counts = runCounts(watch)
      metric.textContent =
        counts.failed > 0
          ? labels.failed(counts.failed)
          : counts.total > 0
            ? labels.runs(counts.done, counts.total)
            : ""
      metric.hidden = metric.textContent === ""
    }

    note.hidden = sessionID !== null && (watch !== null || !fresh || model.failure !== null)
    note.textContent =
      sessionID === null ? labels.noChat : model.enabled === null ? labels.loading : labels.noWatch
    if (watch?.pr) {
      const verdict = plainLabel(watch.pr.verdictLabel)
      pr.textContent = `PR #${watch.pr.number}: ${verdict}`
      pr.setAttribute("data-ready", String(watch.pr.ready))
      const first = watch.pr.blockers[0]
      const remaining = watch.pr.blockers.length - 1
      blocker.textContent = first ? `${first}${remaining > 0 ? `  ${labels.more(remaining)}` : ""}` : ""
      blocker.hidden = first === undefined
    } else {
      pr.textContent = ""
      blocker.textContent = ""
      blocker.hidden = true
    }
    pr.hidden = sessionID === null || watch?.pr == null
    summary.hidden = readout.hidden && note.hidden && pr.hidden && blocker.hidden

    const connectionView = describeConnection(model.state)
    connection.hidden = sessionID === null || (fresh && model.state.connection.kind === "live")
    connection.textContent = connection.hidden ? "" : connectionView.text
    connection.setAttribute("data-tone", connectionView.tone)
    error.hidden = sessionID === null || model.failure === null
    errorText.textContent = model.failure === null ? "" : failureText(model.failure, model.state.locale)
    retry.update({ label: labels.retry, disabled: !model.canRetry })
    height.fit()
  }
  controller = createStatusController(binding, host, render)
  return () => {
    controller?.dispose()
    height.dispose()
    toggle.dispose()
    phase.dispose()
    retry.dispose()
    style.remove()
  }
}
