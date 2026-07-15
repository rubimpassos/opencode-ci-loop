import { assertNever, type CiReport, type WorkflowRun } from "./types.ts"

export function runIcon(run: WorkflowRun): string {
  switch (run.status) {
    case "queued":
      return "⏳"
    case "in_progress":
      return "🔄"
    case "completed":
      return run.conclusion === "success" ? "✅" : run.conclusion === "skipped" ? "⏭️" : "❌"
    default:
      return assertNever(run.status)
  }
}

export function summarizeRuns(runs: readonly WorkflowRun[]): string {
  const total = runs.length
  const completed = runs.filter((run) => run.status === "completed")
  const failing = completed.filter(
    (run) => run.conclusion !== "success" && run.conclusion !== "skipped",
  ).length
  const passing = completed.length - failing
  if (completed.length === total) {
    return failing === 0 ? `${passing}/${total} passing` : `${failing}/${total} failing`
  }
  return `${completed.length}/${total} completed${failing > 0 ? ` (${failing} failing)` : ""}`
}

export function isReportClean(report: CiReport): boolean {
  return report.runs.every((run) => run.conclusion === "success" || run.conclusion === "skipped")
}

/** Relatório em markdown injetado como prompt sintético na sessão. */
export function renderPromptReport(report: CiReport): string {
  const lines: string[] = [
    `[ci-loop] Resultado do CI para o push \`${report.sha.slice(0, 8)}\` (branch \`${report.branch}\`):`,
    "",
  ]
  for (const run of report.runs) {
    lines.push(`- ${runIcon(run)} **${run.workflowName}** — ${run.conclusion ?? run.status} (${run.url})`)
  }
  if (isReportClean(report)) {
    lines.push("", "Todos os checks passaram. Nenhuma ação necessária — não responda a esta mensagem.")
    return lines.join("\n")
  }
  lines.push("", "## Logs das falhas")
  for (const failed of report.failedLogs) {
    lines.push("", `### ${failed.runName} (run ${failed.runId})`, "```", failed.logTail.trim(), "```")
  }
  lines.push(
    "",
    "Analise as falhas acima, corrija a causa raiz e faça push da correção.",
    "Se a falha não estiver relacionada às suas mudanças, apenas reporte isso.",
  )
  return lines.join("\n")
}
