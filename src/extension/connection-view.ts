import type { HostRequestErrorCode } from "@openchamber/sdk"
import type { PanelSnapshot } from "../panel-types.ts"
import type { GuestLocale } from "./locale.ts"
import type { InvalidDataReason } from "./schemas.ts"

/** How the guest currently reaches the plugin. `polling` is the relay fallback, never live SSE. */
export type Connection =
  | { readonly kind: "connecting" }
  | { readonly kind: "live" }
  | { readonly kind: "polling" }
  /** Plugin or host unreachable; `code` is the host's typed refusal, `status` an upstream HTTP status. */
  | {
      readonly kind: "unavailable"
      readonly code: HostRequestErrorCode | null
      readonly status: number | null
    }
  | { readonly kind: "forbidden" }
  | { readonly kind: "invalid-data"; readonly reason: InvalidDataReason }

/** `stale`: `snapshot` is the last good one, kept while the connection is not delivering fresh data. */
export type BindingState = {
  readonly connection: Connection
  readonly snapshot: PanelSnapshot | null
  readonly stale: boolean
  readonly locale: GuestLocale
}

export type ConnectionTone = "info" | "success" | "warning" | "error"
export type ConnectionView = { readonly tone: ConnectionTone; readonly text: string }

type Labels = {
  readonly connecting: string
  readonly live: string
  readonly polling: string
  readonly unavailable: string
  readonly forbidden: string
  readonly unreadable: string
  readonly updateRequired: string
  readonly stale: string
}

const LABELS: Readonly<Record<GuestLocale, Labels>> = {
  en: {
    connecting: "Connecting to CI Loop…",
    live: "Live",
    polling: "Updating every 5 s (live stream unavailable here)",
    unavailable: "CI Loop plugin is unreachable",
    forbidden: "CI Loop access is not approved",
    unreadable: "CI Loop sent data this extension cannot read",
    updateRequired: "The CI Loop plugin is older than this extension — update it",
    stale: "showing last known data",
  },
  "pt-BR": {
    connecting: "Conectando ao CI Loop…",
    live: "Ao vivo",
    polling: "Atualizando a cada 5 s (stream ao vivo indisponível aqui)",
    unavailable: "Plugin CI Loop inacessível",
    forbidden: "Acesso ao CI Loop não aprovado",
    unreadable: "O CI Loop enviou dados que esta extensão não consegue ler",
    updateRequired: "O plugin CI Loop é mais antigo que esta extensão — atualize-o",
    stale: "exibindo os últimos dados conhecidos",
  },
}

function base(connection: Connection, labels: Labels): ConnectionView {
  switch (connection.kind) {
    case "connecting":
      return { tone: "info", text: labels.connecting }
    case "live":
      return { tone: "success", text: labels.live }
    case "polling":
      return { tone: "info", text: labels.polling }
    case "unavailable":
      return { tone: "error", text: labels.unavailable }
    case "forbidden":
      return { tone: "error", text: labels.forbidden }
    case "invalid-data":
      return {
        tone: "error",
        text: connection.reason === "update-required" ? labels.updateRequired : labels.unreadable,
      }
    default:
      return assertNever(connection)
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled connection ${JSON.stringify(value)}`)
}

export function describeConnection(state: BindingState): ConnectionView {
  const labels = LABELS[state.locale]
  const view = base(state.connection, labels)
  if (!state.stale) return view
  return { tone: view.tone === "error" ? "error" : "warning", text: `${view.text} · ${labels.stale}` }
}
