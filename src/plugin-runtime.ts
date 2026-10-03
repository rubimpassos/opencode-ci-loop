import { bunExec, GhClient } from "./gh.ts"
import { type CiLoopHost, SessionIdSchema } from "./host-port.ts"
import type { Locale } from "./i18n.ts"
import { clearSessionNotifications, type NotifyContext, notifyPhase, notifyReviewUpdate } from "./notify.ts"
import { buildPanelSnapshot } from "./panel-view.ts"
import { WatchRegistry } from "./registry.ts"
import { renderWatchNotice } from "./render.ts"
import { resolvePushTargets } from "./resolve.ts"
import { DashboardServer } from "./server.ts"
import type { PluginConfig, SessionId } from "./types.ts"
import type { WatchToolContext } from "./watch-tool.ts"

type HostRegistration = {
  readonly host: CiLoopHost
  readonly controller: AbortController
  readonly sessions: Set<SessionId>
}

export type SharedCiLoop = {
  readonly registry: WatchRegistry
  readonly dashboard: DashboardServer
  readonly refs: number
  readonly hosts: Set<HostRegistration>
  readonly notifications: Set<string>
  readonly locales: Map<SessionId, Locale>
  readonly titles: Map<SessionId, string>
  readonly publish: () => void
}

export type RuntimeLease = WatchToolContext & {
  readonly shared: SharedCiLoop
  readonly registration: HostRegistration
  readonly port: number
}

const SHARED_KEY = Symbol.for("opencode-ci-loop.shared")
const holder: typeof globalThis & { [SHARED_KEY]?: Map<number, SharedCiLoop> } = globalThis
const PUSH_PATTERN = /\bgit\b[^\n;|&]*\bpush\b/
const PUSH_FAILURE_MARKERS = ["! [rejected]", "fatal:", "error: failed to push"] as const

export function isGitPush(command: string): boolean {
  return PUSH_PATTERN.test(command) && !command.includes("--dry-run")
}

function notificationTarget(shared: SharedCiLoop, sessionID: SessionId): HostRegistration | undefined {
  const hosts = [...shared.hosts]
  return (
    hosts.findLast((entry) => entry.host.sessionScope === "owned" && entry.sessions.has(sessionID)) ??
    hosts.findLast((entry) => entry.host.sessionScope === "global")
  )
}

function createShared(config: PluginConfig, registration: HostRegistration): SharedCiLoop {
  const hosts = new Set([registration])
  const dashboard = new DashboardServer(config.dashboard, (level, message) => {
    void [...hosts].at(-1)?.host.log(level, message)
  })
  const notifications = new Set<string>()
  const locales = new Map<SessionId, Locale>()
  const titles = new Map<SessionId, string>()
  const withHost = async (
    sessionID: SessionId,
    signal: AbortSignal,
    notify: (ctx: NotifyContext, signal: AbortSignal) => Promise<void>,
  ): Promise<void> => {
    const target = notificationTarget(shared, sessionID)
    if (!target) return
    const combined = AbortSignal.any([signal, target.controller.signal])
    try {
      await notify({ host: target.host, notifications, locales, config }, combined)
    } catch (error) {
      if (!(error instanceof Error) || !combined.aborted) throw error
    }
  }
  const registry = new WatchRegistry(config, {
    onChange: (sessions) => dashboard.broadcast(sessions),
    onPhase: (sessionID, watch, signal) =>
      withHost(sessionID, signal, (ctx, combined) => notifyPhase(ctx, sessionID, watch, combined)),
    onReviewUpdate: (sessionID, watch, update, signal) =>
      withHost(sessionID, signal, (ctx, combined) =>
        notifyReviewUpdate(ctx, sessionID, watch, update, combined),
      ),
  })
  const shared: SharedCiLoop = {
    registry,
    dashboard,
    hosts,
    notifications,
    locales,
    titles,
    get refs() {
      return hosts.size
    },
    publish: () => dashboard.broadcast(registry.snapshot()),
  }
  dashboard.setControl({
    getSession: (id) => registry.sessionView(SessionIdSchema.parse(id)),
    setEnabled: (id, enabled) => {
      const sessionID = SessionIdSchema.parse(id)
      registry.setEnabled(sessionID, enabled)
      return registry.sessionView(sessionID)
    },
  })
  dashboard.setPanelMapper((sessions, locale) => {
    const deps = { language: config.language, locales, titles }
    return buildPanelSnapshot(sessions, locale === undefined ? deps : { ...deps, locale })
  })
  dashboard.start()
  return shared
}

/** One server per port, one registration per instance (even when instances reuse the same host). */
export function acquireShared(config: PluginConfig, host: CiLoopHost, directory = ""): RuntimeLease {
  holder[SHARED_KEY] ??= new Map()
  const map = holder[SHARED_KEY]
  const registration: HostRegistration = { host, controller: new AbortController(), sessions: new Set() }
  const shared = map.get(config.dashboard.port) ?? createShared(config, registration)
  shared.hosts.add(registration)
  map.set(config.dashboard.port, shared)
  return {
    shared,
    registration,
    port: config.dashboard.port,
    registry: shared.registry,
    dashboardUrl: shared.dashboard.url,
    directory,
  }
}

export function claimSession(lease: RuntimeLease, sessionID: SessionId): void {
  if (!lease.registration.controller.signal.aborted) lease.registration.sessions.add(sessionID)
}

/** Global V1 events retain their existing behavior; scoped hosts only mutate their own sessions. */
export function updateSessionTitle(lease: RuntimeLease, sessionID: SessionId, title: string): void {
  if (!acceptsSessionEvent(lease, sessionID)) return
  if (lease.shared.titles.get(sessionID) === title) return
  lease.shared.titles.set(sessionID, title)
  lease.shared.publish()
}

function acceptsSessionEvent(lease: RuntimeLease, sessionID: SessionId): boolean {
  return (
    !lease.registration.controller.signal.aborted &&
    (lease.registration.host.sessionScope === "global" || lease.registration.sessions.has(sessionID))
  )
}

export function removeSession(lease: RuntimeLease, sessionID: SessionId): void {
  if (!acceptsSessionEvent(lease, sessionID)) return
  const { shared } = lease
  for (const entry of shared.hosts) entry.sessions.delete(sessionID)
  shared.registry.remove(sessionID)
  shared.titles.delete(sessionID)
  clearSessionNotifications(shared.notifications, sessionID, shared.locales)
}

async function ensureTitle(lease: RuntimeLease, sessionID: SessionId): Promise<void> {
  const { shared } = lease
  if (shared.titles.has(sessionID)) return
  const target = notificationTarget(shared, sessionID)
  if (!target) return
  try {
    const title = await target.host.getSessionTitle(sessionID, target.controller.signal)
    if (
      title &&
      !target.controller.signal.aborted &&
      !lease.registration.controller.signal.aborted &&
      lease.registration.sessions.has(sessionID) &&
      !shared.titles.has(sessionID)
    ) {
      shared.titles.set(sessionID, title)
      shared.publish()
    }
  } catch (error) {
    // A missing title must not prevent a watch; the panel falls back to the session ID.
    if (!(error instanceof Error)) throw error
  }
}

export type PushResult = {
  readonly sessionID: SessionId
  readonly command: string
  readonly output: string
  readonly args: { readonly workdir?: string; readonly cwd?: string }
}

/** Adapters check shell-tool completion; this flow retains V1's rejection/dry-run policy. */
export async function handlePushResult(lease: RuntimeLease, result: PushResult): Promise<string> {
  if (
    lease.registration.controller.signal.aborted ||
    !isGitPush(result.command) ||
    PUSH_FAILURE_MARKERS.some((marker) => result.output.includes(marker))
  )
    return result.output
  const { sessionID } = result
  claimSession(lease, sessionID)
  if (!lease.registry.isEnabled(sessionID, lease.directory)) return result.output
  void ensureTitle(lease, sessionID)
  const targets = await resolvePushTargets(result.output, result.command, result.args, {
    exec: bunExec,
    sessionDir: lease.directory,
  })
  if (
    lease.registration.controller.signal.aborted ||
    !lease.registration.sessions.has(sessionID) ||
    !lease.registry.isEnabled(sessionID, lease.directory) ||
    targets.length === 0
  )
    return result.output
  for (const target of targets) {
    const gh = new GhClient(bunExec, target.directory ?? lease.directory, target.repoUrl)
    void lease.registry.startWatch(sessionID, target, gh, lease.directory)
  }
  return result.output + renderWatchNotice(targets)
}

export function releaseShared(lease: RuntimeLease): void {
  const { shared, registration } = lease
  if (!shared.hosts.delete(registration)) return
  registration.controller.abort()
  for (const sessionID of registration.sessions) {
    if (notificationTarget(shared, sessionID)) continue
    shared.registry.remove(sessionID)
    shared.titles.delete(sessionID)
    clearSessionNotifications(shared.notifications, sessionID, shared.locales)
  }
  if (shared.refs > 0) return
  shared.registry.dispose()
  shared.dashboard.stop()
  holder[SHARED_KEY]?.delete(lease.port)
}
