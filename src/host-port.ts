import { z } from "zod"
import type { LogLevel, SessionId } from "./types.ts"

export const SessionIdSchema = z.custom<SessionId>((value) => typeof value === "string" && value.length > 0)

export type SessionModel = { readonly providerID: string; readonly modelID: string }
export type HostSessionContext = { readonly model?: SessionModel; readonly lastUserText: string }
export type HostPrompt = { readonly model?: SessionModel; readonly text: string }
export type HostToast = {
  readonly title: string
  readonly message: string
  readonly variant: "info" | "success" | "warning" | "error"
}

/** Adapters admit prompts once, honor cancellation, and keep diagnostics off the terminal. */
export interface CiLoopHost {
  /** Global V1 clients can serve any session; scoped adapters only serve claimed sessions. */
  readonly sessionScope: "global" | "owned"
  readonly getSessionTitle: (sessionID: SessionId, signal?: AbortSignal) => Promise<string | undefined>
  readonly readSessionContext: (sessionID: SessionId, signal?: AbortSignal) => Promise<HostSessionContext>
  readonly prompt: (sessionID: SessionId, content: HostPrompt, signal?: AbortSignal) => Promise<void>
  readonly toast?: (content: HostToast, signal?: AbortSignal) => Promise<void>
  readonly log: (level: LogLevel, message: string) => Promise<void>
}
