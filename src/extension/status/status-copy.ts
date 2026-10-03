import type { PanelWatch } from "../../panel-types.ts"
import type { RequestFailure } from "../binding.ts"
import type { GuestLocale } from "../locale.ts"

type Labels = {
  readonly watch: string
  readonly description: string
  readonly noChat: string
  readonly noWatch: string
  readonly loading: string
  readonly retry: string
  readonly requestFailed: string
  readonly rejected: string
  readonly unreadable: string
  readonly more: (count: number) => string
  readonly runs: (done: number, total: number) => string
  readonly failed: (count: number) => string
}

export const STATUS_LABELS: Readonly<Record<GuestLocale, Labels>> = {
  en: {
    watch: "Watch CI for this chat",
    description: "Follow runs and PR readiness after a push",
    noChat: "Open a chat to see its CI status.",
    noWatch: "No CI watch yet. Push a branch to start one.",
    loading: "Reading this chat's CI setting…",
    retry: "Retry",
    requestFailed: "Couldn't reach this chat's CI setting.",
    rejected: "The CI Loop plugin rejected this change",
    unreadable: "The CI Loop plugin returned an unreadable session.",
    more: (count) => `+${count} more`,
    runs: (done, total) => `${done}/${total} runs done`,
    failed: (count) => `${count} failed`,
  },
  "pt-BR": {
    watch: "Acompanhar CI deste chat",
    description: "Acompanhe execuções e o PR após um push",
    noChat: "Abra um chat para ver o estado da CI.",
    noWatch: "Nenhum acompanhamento de CI ainda. Faça push de uma branch.",
    loading: "Consultando a configuração de CI deste chat…",
    retry: "Tentar novamente",
    requestFailed: "Não foi possível consultar a configuração de CI deste chat.",
    rejected: "O plugin CI Loop recusou a alteração",
    unreadable: "O plugin CI Loop retornou uma sessão ilegível.",
    more: (count) => `+${count} mais`,
    runs: (done, total) => `${done}/${total} execuções concluídas`,
    failed: (count) => `${count} com falha`,
  },
}

export function runCounts(watch: PanelWatch): {
  readonly done: number
  readonly total: number
  readonly failed: number
} {
  const done = watch.runs.filter((run) => run.status === "completed").length
  const failedRuns = watch.runs.filter(
    (run) => run.status === "completed" && !["success", "skipped", "neutral"].includes(run.state),
  ).length
  const failedChecks = watch.checks.filter((check) => check.failing).length
  return { done, total: watch.runs.length, failed: failedRuns + failedChecks }
}

export function failureText(failure: RequestFailure, locale: GuestLocale): string {
  const labels = STATUS_LABELS[locale]
  switch (failure.kind) {
    case "forbidden":
    case "unavailable":
      return labels.requestFailed
    case "rejected":
      return `${labels.rejected} (${failure.status}): ${failure.message}`
    case "invalid-data":
      return labels.unreadable
    default:
      return assertNever(failure)
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled status failure ${JSON.stringify(value)}`)
}
