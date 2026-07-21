import type { GhClient } from "./gh.ts"
import type {
  PluginConfig,
  PushTarget,
  SessionId,
  SessionState,
  Watch,
  WatchKey,
  WatchPhase,
} from "./types.ts"

/** Subset of GhClient that a watch needs. Injected per push (each project has its own cwd). */
export type CiGh = Pick<GhClient, "listRuns" | "buildReport">

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>

export const abortableSleep: Sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
  })

export type RegistryEvents = {
  /** Snapshot completo mudou (dashboard SSE). */
  readonly onChange: (sessions: readonly SessionState[]) => void
  /** Phase transition of a watch (toasts). */
  readonly onPhase: (sessionID: SessionId, watch: Watch, signal: AbortSignal) => Promise<void>
}

type WatchSlot = {
  watch: Watch
  readonly controller: AbortController
}

type MutableSession = {
  sessionID: SessionId
  enabled: boolean
  readonly watches: Map<WatchKey, WatchSlot>
  directory: string | null
}

export function watchKey(repo: string, branch: string): WatchKey {
  return `${repo}\0refs/heads/${branch}` as WatchKey
}

export class WatchRegistry {
  private readonly sessions = new Map<SessionId, MutableSession>()

  constructor(
    private readonly config: PluginConfig,
    private readonly events: RegistryEvents,
    private readonly sleep: Sleep = abortableSleep,
  ) {}

  snapshot(): readonly SessionState[] {
    return [...this.sessions.values()].map((session) => this.state(session))
  }

  /** Pure read: does NOT create the session (unlike `session`/`isEnabled`); defaults to `autoWatch` if never seen. */
  sessionView(sessionID: SessionId): SessionState {
    const existing = this.sessions.get(sessionID)
    if (existing) return this.state(existing)
    return {
      sessionID,
      enabled: this.config.autoWatch,
      watches: [],
      watch: null,
      directory: null,
    }
  }

  isEnabled(sessionID: SessionId, directory?: string): boolean {
    return this.session(sessionID, directory).enabled
  }

  setEnabled(sessionID: SessionId, enabled: boolean, directory?: string): void {
    const session = this.session(sessionID, directory)
    session.enabled = enabled
    if (!enabled) this.stopAll(session)
    this.events.onChange(this.snapshot())
  }

  remove(sessionID: SessionId): void {
    const session = this.sessions.get(sessionID)
    if (!session) return
    this.stopAll(session)
    this.sessions.delete(sessionID)
    this.events.onChange(this.snapshot())
  }

  async startWatch(sessionID: SessionId, target: PushTarget, gh: CiGh, directory?: string): Promise<void> {
    const session = this.session(sessionID, directory)
    const key = watchKey(target.repo, target.branch)
    this.stopKey(session, key)
    const controller = new AbortController()
    const watch: Watch = {
      ...target,
      startedAt: Date.now(),
      phase: { kind: "waiting" },
    }
    session.watches.set(key, { watch, controller })
    this.publish(session, key, controller)
    try {
      await this.watchLoop(session, key, target, gh, controller)
    } catch (error) {
      if (!this.isCurrent(session, key, controller)) return
      const message = error instanceof Error ? error.message : String(error)
      this.setPhase(session, key, controller, { kind: "error", message })
    }
  }

  dispose(): void {
    for (const session of this.sessions.values()) this.stopAll(session)
  }

  private async watchLoop(
    session: MutableSession,
    key: WatchKey,
    target: PushTarget,
    gh: CiGh,
    controller: AbortController,
  ): Promise<void> {
    const { signal } = controller
    const deadline = Date.now() + this.config.timeoutMs
    await this.sleep(this.config.initialDelayMs, signal)

    while (this.isCurrent(session, key, controller) && Date.now() < deadline) {
      const runs = await gh.listRuns(target.sha, target.branch)
      if (!this.isCurrent(session, key, controller)) return
      if (runs.length > 0) {
        if (runs.every((run) => run.status === "completed")) {
          const report = await gh.buildReport(target, this.config.failLogLines)
          if (!this.isCurrent(session, key, controller)) return
          this.setPhase(session, key, controller, { kind: "done", report })
          return
        }
        this.setPhase(session, key, controller, { kind: "running", runs })
      }
      await this.sleep(this.config.pollIntervalMs, signal)
    }

    if (!this.isCurrent(session, key, controller)) return
    const phase = session.watches.get(key)?.watch.phase
    const runs = phase?.kind === "running" ? phase.runs : []
    this.setPhase(session, key, controller, { kind: "timed-out", runs })
  }

  private setPhase(
    session: MutableSession,
    key: WatchKey,
    controller: AbortController,
    phase: WatchPhase,
  ): void {
    if (!this.isCurrent(session, key, controller)) return
    const slot = session.watches.get(key)
    if (!slot) return
    slot.watch = { ...slot.watch, phase }
    this.publish(session, key, controller)
  }

  private publish(session: MutableSession, key: WatchKey, controller: AbortController): void {
    if (!this.isCurrent(session, key, controller)) return
    const watch = session.watches.get(key)?.watch
    if (!watch) return
    this.events.onChange(this.snapshot())
    void this.events.onPhase(session.sessionID, watch, controller.signal)
  }

  private isCurrent(session: MutableSession, key: WatchKey, controller: AbortController): boolean {
    return session.watches.get(key)?.controller === controller && !controller.signal.aborted
  }

  private stopKey(session: MutableSession, key: WatchKey): void {
    session.watches.get(key)?.controller.abort()
    session.watches.delete(key)
  }

  private stopAll(session: MutableSession): void {
    for (const slot of session.watches.values()) slot.controller.abort()
    session.watches.clear()
  }

  private state(session: MutableSession): SessionState {
    const watches = [...session.watches.values()]
      .map((slot) => slot.watch)
      .sort((left, right) => left.startedAt - right.startedAt)
    return {
      sessionID: session.sessionID,
      enabled: session.enabled,
      watches,
      watch: watches.at(-1) ?? null,
      directory: session.directory,
    }
  }

  private session(sessionID: SessionId, directory?: string): MutableSession {
    let session = this.sessions.get(sessionID)
    if (!session) {
      session = {
        sessionID,
        enabled: this.config.autoWatch,
        watches: new Map(),
        directory: directory ?? null,
      }
      this.sessions.set(sessionID, session)
    } else if (directory !== undefined) {
      session.directory = directory
    }
    return session
  }
}
