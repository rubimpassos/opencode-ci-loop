import type { HostClient } from "@openchamber/sdk"
import { mountBanner, mountButton, mountSwitch } from "@openchamber/sdk/ui"
import type { PanelChrome, PanelSession } from "../../panel-types.ts"
import type { PanelBinding, RequestFailure, SessionOutcome } from "../binding.ts"
import type { GuestLocale } from "../locale.ts"
import { node, syncChildren } from "./dom-list.ts"
import { WatchView } from "./watch-view.ts"

export type SessionEnvironment = {
  readonly binding: Pick<PanelBinding, "setEnabled">
  readonly host: Pick<HostClient, "openUrl">
  readonly locale: GuestLocale
}

function failureText(failure: RequestFailure, locale: GuestLocale): string {
  switch (failure.kind) {
    case "forbidden":
      return locale === "pt-BR" ? "Acesso não aprovado." : "Access is not approved."
    case "unavailable":
      return locale === "pt-BR" ? "O plugin está indisponível." : "The plugin is unavailable."
    case "invalid-data":
      return locale === "pt-BR" ? "A resposta não pôde ser lida." : "The response could not be read."
    case "rejected":
      return `${failure.status}: ${failure.message}`
    default:
      return assertNever(failure)
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled panel outcome ${JSON.stringify(value)}`)
}

export class SessionView {
  readonly element = node("section", "ci-session")
  private readonly title = node("h2", "ci-session-title")
  private readonly project = node("span", "ci-project")
  private readonly id = node("span", "ci-session-id")
  private readonly switchRoot = node("span", "ci-switch")
  private readonly errorRoot = node("div", "ci-session-error")
  private readonly retryRoot = node("span", "ci-retry")
  private readonly watchesRoot = node("div", "ci-watches")
  private readonly waiting = node("p", "ci-session-waiting")
  private readonly toggle: ReturnType<typeof mountSwitch>
  private readonly banner: ReturnType<typeof mountBanner>
  private readonly retry: ReturnType<typeof mountButton>
  private readonly watches = new Map<string, WatchView>()
  private chrome: PanelChrome | null = null
  private currentEnabled = false
  private writable = false
  private pending = false
  private disposed = false
  private retryTarget: boolean | null = null
  private error: string | null = null

  constructor(
    private readonly sessionID: string,
    private readonly environment: SessionEnvironment,
  ) {
    const identity = node("div", "ci-identity")
    const header = node("div", "ci-session-head")
    identity.append(this.project, this.title, this.id)
    header.append(identity, this.switchRoot)
    this.toggle = mountSwitch(this.switchRoot, {
      label: "",
      checked: false,
      disabled: true,
      onChange: (enabled) => this.submit(enabled),
    })
    this.banner = mountBanner(this.errorRoot, { tone: "error", title: "", body: "" })
    this.retry = mountButton(this.retryRoot, {
      label: environment.locale === "pt-BR" ? "Tentar novamente" : "Retry",
      variant: "secondary",
      size: "xs",
      onClick: () => {
        if (this.retryTarget !== null) this.submit(this.retryTarget)
      },
    })
    this.errorRoot.append(this.retryRoot)
    this.errorRoot.hidden = true
    this.element.append(header, this.errorRoot, this.watchesRoot, this.waiting)
  }

  update(session: PanelSession, chrome: PanelChrome, writable: boolean): void {
    this.chrome = chrome
    this.writable = writable
    const name = session.title ?? session.sessionID
    this.title.textContent = name
    this.title.classList.toggle("ci-id-fallback", session.title === null)
    this.id.hidden = session.title === null
    this.id.textContent = session.sessionID
    this.project.hidden = session.projectLabel === null
    this.project.textContent = session.projectLabel
    this.project.title = session.directory ?? ""
    this.waiting.hidden = session.watches.length > 0
    this.waiting.textContent = chrome.emptyWaiting
    const watchNodes: HTMLElement[] = []
    for (const watch of session.watches) {
      let view = this.watches.get(watch.key)
      if (!view) {
        view = new WatchView(this.environment.host, this.environment.locale)
        this.watches.set(watch.key, view)
      }
      view.update(watch)
      watchNodes.push(view.element)
    }
    syncChildren(this.watchesRoot, watchNodes)
    this.paintControls()
  }

  /** Only a new server frame can supersede a confirmed write; local filter renders cannot. */
  syncEnabled(enabled: boolean): void {
    if (!this.pending) this.currentEnabled = enabled
  }

  pruneWatches(session: PanelSession): void {
    const current = new Set(session.watches.map((watch) => watch.key))
    for (const [key, view] of this.watches) {
      if (current.has(key)) continue
      view.dispose()
      view.element.remove()
      this.watches.delete(key)
    }
  }

  private paintControls(): void {
    const chrome = this.chrome
    if (chrome === null) return
    this.toggle.update({
      checked: this.currentEnabled,
      label: this.currentEnabled ? chrome.watchOn : chrome.watchOff,
      disabled: !this.writable || this.pending,
    })
    const name = this.title.textContent ?? this.sessionID
    this.switchRoot
      .querySelector('[role="switch"]')
      ?.setAttribute(
        "aria-label",
        this.environment.locale === "pt-BR" ? `Acompanhar CI em ${name}` : `Watch CI for ${name}`,
      )
    this.errorRoot.hidden = this.error === null
    if (this.error !== null) {
      this.banner.update({
        title:
          this.environment.locale === "pt-BR"
            ? "Não foi possível alterar o acompanhamento"
            : "Could not change CI watch",
        body: this.error,
      })
    }
    this.retryRoot.hidden = this.retryTarget === null
    this.retry.update({ disabled: !this.writable || this.pending })
  }

  private submit(enabled: boolean): void {
    if (!this.writable || this.pending || this.disposed) return
    this.pending = true
    this.error = null
    this.retryTarget = null
    this.paintControls()
    void this.environment.binding
      .setEnabled(this.sessionID, enabled)
      .then((result) => this.finish(enabled, result))
  }

  private finish(enabled: boolean, result: SessionOutcome): void {
    if (this.disposed) return
    this.pending = false
    switch (result.kind) {
      case "ok":
        if (result.value.sessionID === this.sessionID) {
          this.currentEnabled = result.value.enabled
          break
        }
        this.error =
          this.environment.locale === "pt-BR"
            ? "A resposta pertence a outra sessão."
            : "Response belongs to another session."
        this.retryTarget = enabled
        break
      case "failed":
        this.error = failureText(result.failure, this.environment.locale)
        this.retryTarget = enabled
        break
      case "superseded":
        break
      default:
        assertNever(result)
    }
    this.paintControls()
  }

  dispose(): void {
    this.disposed = true
    this.toggle.dispose()
    this.banner.dispose()
    this.retry.dispose()
    for (const watch of this.watches.values()) watch.dispose()
    this.watches.clear()
  }
}
