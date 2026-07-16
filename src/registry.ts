import type { GhClient } from "./gh.ts"
import type { CommitSha, PluginConfig, SessionId, SessionState, Watch, WatchPhase } from "./types.ts"

/** Subconjunto do GhClient que um watch precisa. Injetado por push (cada projeto tem seu cwd). */
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
  /** Transição de fase de um watch (toasts). */
  readonly onPhase: (sessionID: SessionId, watch: Watch) => Promise<void>
}

type MutableSession = {
  sessionID: SessionId
  enabled: boolean
  watch: Watch | null
  controller: AbortController | null
  directory: string | null
}

export class WatchRegistry {
  private readonly sessions = new Map<SessionId, MutableSession>()

  constructor(
    private readonly config: PluginConfig,
    private readonly events: RegistryEvents,
    private readonly sleep: Sleep = abortableSleep,
  ) {}

  snapshot(): readonly SessionState[] {
    return [...this.sessions.values()].map(({ sessionID, enabled, watch, directory }) => ({
      sessionID,
      enabled,
      watch,
      directory,
    }))
  }

  /** Leitura pura: NÃO cria a sessão (ao contrário de `session`/`isEnabled`); default `autoWatch` se nunca vista. */
  sessionView(sessionID: SessionId): SessionState {
    const existing = this.sessions.get(sessionID)
    return {
      sessionID,
      enabled: existing?.enabled ?? this.config.autoWatch,
      watch: existing?.watch ?? null,
      directory: existing?.directory ?? null,
    }
  }

  isEnabled(sessionID: SessionId, directory?: string): boolean {
    return this.session(sessionID, directory).enabled
  }

  setEnabled(sessionID: SessionId, enabled: boolean, directory?: string): void {
    const session = this.session(sessionID, directory)
    session.enabled = enabled
    if (!enabled) {
      this.stopWatch(session)
    }
    this.events.onChange(this.snapshot())
  }

  remove(sessionID: SessionId): void {
    const session = this.sessions.get(sessionID)
    if (session) {
      this.stopWatch(session)
      this.sessions.delete(sessionID)
      this.events.onChange(this.snapshot())
    }
  }

  /** Inicia (ou substitui) o watch de CI da sessão para o commit dado. */
  async startWatch(
    sessionID: SessionId,
    sha: CommitSha,
    branch: string,
    gh: CiGh,
    directory?: string,
  ): Promise<void> {
    const session = this.session(sessionID, directory)
    this.stopWatch(session)
    const controller = new AbortController()
    session.controller = controller
    this.setPhase(session, sha, branch, { kind: "waiting" })
    try {
      await this.watchLoop(session, sha, branch, gh, controller.signal)
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error)
        this.setPhase(session, sha, branch, { kind: "error", message })
      }
    }
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      this.stopWatch(session)
    }
  }

  private async watchLoop(
    session: MutableSession,
    sha: CommitSha,
    branch: string,
    gh: CiGh,
    signal: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + this.config.timeoutMs
    await this.sleep(this.config.initialDelayMs, signal)

    while (!signal.aborted && Date.now() < deadline) {
      const runs = await gh.listRuns(sha)
      if (signal.aborted) return

      if (runs.length > 0) {
        const allDone = runs.every((run) => run.status === "completed")
        if (allDone) {
          const report = await gh.buildReport(sha, branch, this.config.failLogLines)
          if (signal.aborted) return
          this.setPhase(session, sha, branch, { kind: "done", report })
          return
        }
        this.setPhase(session, sha, branch, { kind: "running", runs })
      }
      await this.sleep(this.config.pollIntervalMs, signal)
    }

    if (!signal.aborted) {
      const runs = session.watch?.phase.kind === "running" ? session.watch.phase.runs : []
      this.setPhase(session, sha, branch, { kind: "timed-out", runs })
    }
  }

  private setPhase(session: MutableSession, sha: CommitSha, branch: string, phase: WatchPhase): void {
    const startedAt = session.watch?.sha === sha ? session.watch.startedAt : Date.now()
    session.watch = { sha, branch, startedAt, phase }
    this.events.onChange(this.snapshot())
    void this.events.onPhase(session.sessionID, session.watch)
  }

  private stopWatch(session: MutableSession): void {
    session.controller?.abort()
    session.controller = null
  }

  private session(sessionID: SessionId, directory?: string): MutableSession {
    let session = this.sessions.get(sessionID)
    if (!session) {
      session = {
        sessionID,
        enabled: this.config.autoWatch,
        watch: null,
        controller: null,
        directory: directory ?? null,
      }
      this.sessions.set(sessionID, session)
    } else if (directory !== undefined) {
      session.directory = directory
    }
    return session
  }
}
