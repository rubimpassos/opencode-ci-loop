import {
  array,
  boolean,
  enum as enumOf,
  extend,
  int,
  minLength,
  nullable,
  object,
  record,
  string,
  type ZodMiniType,
} from "zod/mini"
import { PANEL_PHASE_KEYS, PANEL_TONES, type PanelSnapshot } from "../panel-types.ts"
import type { RunStatus } from "../types.ts"

// Mirrors RUN_STATUSES without bundling the plugin's domain module (and its schemas) into guests.
// The mapped type makes it exhaustive: a new RunStatus fails typecheck here.
const RUN_STATUS = {
  queued: "queued",
  in_progress: "in_progress",
  completed: "completed",
} as const satisfies { readonly [K in RunStatus]: K }

const RunSchema = object({
  name: string(),
  url: string(),
  status: enumOf(RUN_STATUS),
  state: string(),
})

const CheckSchema = object({
  name: string(),
  url: nullable(string()),
  state: string(),
  failing: boolean(),
})

const PrSchema = object({
  number: int(),
  title: string(),
  url: string(),
  ready: boolean(),
  verdictLabel: string(),
  blockers: array(string()),
  draftLabel: nullable(string()),
})

const LegacyWatchSchema = object({
  key: string(),
  meta: string(),
  phaseKey: enumOf(PANEL_PHASE_KEYS),
  tone: enumOf(PANEL_TONES),
  phaseLabel: string(),
  runs: array(RunSchema),
  checks: array(CheckSchema),
  failures: array(object({ runName: string(), logTail: string() })),
  pr: nullable(PrSchema),
  searchText: string(),
})

/** `failed` arrived with the extension; a plugin snapshot without it predates this guest. */
const WatchSchema = extend(LegacyWatchSchema, { failed: boolean() })

const sessionSchema = <W extends ZodMiniType>(watch: W) =>
  object({
    sessionID: string().check(minLength(1)),
    title: nullable(string()),
    projectLabel: nullable(string()),
    directory: nullable(string()),
    enabled: boolean(),
    watches: array(watch),
    searchText: string(),
  })

const ChromeSchema = object({
  pageTitle: string(),
  emptyWaiting: string(),
  noMatches: string(),
  searchPlaceholder: string(),
  filtersLabel: string(),
  filterEnabledAll: string(),
  filterEnabledOn: string(),
  filterEnabledOff: string(),
  watchOn: string(),
  watchOff: string(),
  clearFilters: string(),
  hiddenTemplate: string(),
  phaseChips: record(enumOf(PANEL_PHASE_KEYS), string()),
})

/** Output must stay assignable to the plugin's exported `PanelSnapshot`; a drift fails typecheck. */
export const PanelSnapshotSchema = object({
  chrome: ChromeSchema,
  sessions: array(sessionSchema(WatchSchema)),
}) satisfies ZodMiniType<PanelSnapshot>

const LegacySnapshotSchema = object({
  chrome: ChromeSchema,
  sessions: array(sessionSchema(LegacyWatchSchema)),
})

/** The subset of the plugin's `SessionState` the extension reads from `/sessions/:id` responses. */
export type SessionControlState = { readonly sessionID: string; readonly enabled: boolean }

const SessionControlSchema = object({
  sessionID: string().check(minLength(1)),
  enabled: boolean(),
}) satisfies ZodMiniType<SessionControlState>

/** `update-required`: a plugin older than this extension (it lacks a field the panel needs). */
export type InvalidDataReason = "unreadable" | "update-required"

export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: InvalidDataReason }

function readJson(text: string): { readonly ok: true; readonly json: unknown } | { readonly ok: false } {
  try {
    return { ok: true, json: JSON.parse(text) }
  } catch (error) {
    if (error instanceof SyntaxError) return { ok: false }
    throw error
  }
}

export function parsePanelSnapshot(text: string): Parsed<PanelSnapshot> {
  const read = readJson(text)
  if (!read.ok) return { ok: false, reason: "unreadable" }
  const parsed = PanelSnapshotSchema.safeParse(read.json)
  if (parsed.success) return { ok: true, value: parsed.data }
  return {
    ok: false,
    reason: LegacySnapshotSchema.safeParse(read.json).success ? "update-required" : "unreadable",
  }
}

export function parseSessionControl(text: string): Parsed<SessionControlState> {
  const read = readJson(text)
  if (!read.ok) return { ok: false, reason: "unreadable" }
  const parsed = SessionControlSchema.safeParse(read.json)
  return parsed.success
    ? { ok: true, value: { sessionID: parsed.data.sessionID, enabled: parsed.data.enabled } }
    : { ok: false, reason: "unreadable" }
}
