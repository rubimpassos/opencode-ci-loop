/** Página única do painel de CI — consome /events (SSE) e renderiza o estado ao vivo. */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>CI Loop</title>
<style>
  :root {
    --bg: #0d1117; --panel: #161b22; --border: #30363d; --text: #e6edf3; --muted: #8b949e;
    --green: #3fb950; --red: #f85149; --yellow: #d29922; --blue: #58a6ff;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace; padding: 16px; }
  h1 { font-size: 15px; margin: 0 0 12px; display: flex; align-items: center; gap: 8px; }
  h1 .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); }
  h1 .dot.off { background: var(--red); }
  .empty { color: var(--muted); padding: 24px 0; }
  .session { background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
    padding: 12px; margin-bottom: 12px; }
  .session-head { display: flex; justify-content: space-between; align-items: center; gap: 8px;
    flex-wrap: wrap; }
  .session-id { color: var(--muted); font-size: 12px; }
  .badge { border-radius: 999px; padding: 1px 10px; font-size: 12px; border: 1px solid var(--border); }
  .badge.on { color: var(--green); border-color: var(--green); }
  .badge.off { color: var(--muted); }
  .watch { margin-top: 10px; }
  .watch-meta { color: var(--muted); font-size: 12px; margin-bottom: 8px; }
  .phase { font-weight: 600; }
  .phase.waiting, .phase.running { color: var(--blue); }
  .phase.done-ok { color: var(--green); }
  .phase.done-fail, .phase.error { color: var(--red); }
  .phase.timed-out { color: var(--yellow); }
  .run { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
  .run a { color: var(--text); text-decoration: none; }
  .run a:hover { text-decoration: underline; }
  .run .state { margin-left: auto; font-size: 12px; }
  .state.success { color: var(--green); }
  .state.failure, .state.timed_out, .state.startup_failure { color: var(--red); }
  .state.cancelled, .state.skipped { color: var(--yellow); }
  .state.queued, .state.in_progress { color: var(--blue); }
  .spin { display: inline-block; animation: spin 1.2s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  pre { background: #010409; border: 1px solid var(--border); border-radius: 6px; padding: 10px;
    overflow-x: auto; font-size: 12px; max-height: 320px; }
  details summary { cursor: pointer; color: var(--red); margin-top: 8px; }
</style>
</head>
<body>
<h1><span class="dot" id="conn"></span>CI Loop</h1>
<div id="app"><div class="empty">Aguardando push com CI…</div></div>
<script>
const ICONS = { queued: "…", in_progress: "◐", completed: "" };
function esc(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}
function runRow(run) {
  const state = run.conclusion || run.status;
  const icon = run.status === "in_progress" ? '<span class="spin">◐</span>' : (ICONS[run.status] ?? "");
  return '<div class="run">' + icon + '<a href="' + esc(run.url) + '" target="_blank">'
    + esc(run.workflowName) + "</a><span class=\\"state " + esc(state) + '">' + esc(state) + "</span></div>";
}
function phaseView(watch) {
  const phase = watch.phase;
  if (phase.kind === "waiting") return '<div class="phase waiting">Aguardando o CI iniciar…</div>';
  if (phase.kind === "running")
    return '<div class="phase running">CI rodando</div>' + phase.runs.map(runRow).join("");
  if (phase.kind === "timed-out")
    return '<div class="phase timed-out">Timeout esperando o CI</div>' + phase.runs.map(runRow).join("");
  if (phase.kind === "error") return '<div class="phase error">Erro: ' + esc(phase.message) + "</div>";
  const clean = phase.report.runs.every((r) => r.conclusion === "success" || r.conclusion === "skipped");
  let html = '<div class="phase ' + (clean ? "done-ok" : "done-fail") + '">'
    + (clean ? "✓ CI verde" : "✗ CI com falhas") + "</div>" + phase.report.runs.map(runRow).join("");
  for (const failed of phase.report.failedLogs) {
    html += "<details><summary>" + esc(failed.runName) + "</summary><pre>" + esc(failed.logTail) + "</pre></details>";
  }
  return html;
}
function render(sessions) {
  const app = document.getElementById("app");
  const active = sessions.filter((s) => s.watch || s.enabled);
  if (active.length === 0) {
    app.innerHTML = '<div class="empty">Aguardando push com CI…</div>';
    return;
  }
  app.innerHTML = active.map((session) => {
    const badge = session.enabled ? '<span class="badge on">watch on</span>' : '<span class="badge off">watch off</span>';
    let html = '<div class="session"><div class="session-head"><span class="session-id">'
      + esc(session.sessionID) + "</span>" + badge + "</div>";
    if (session.watch) {
      html += '<div class="watch"><div class="watch-meta">' + esc(session.watch.branch) + " @ "
        + esc(session.watch.sha.slice(0, 8)) + "</div>" + phaseView(session.watch) + "</div>";
    }
    return html + "</div>";
  }).join("");
}
function connect() {
  const source = new EventSource("/events");
  source.onopen = () => document.getElementById("conn").classList.remove("off");
  source.onmessage = (event) => render(JSON.parse(event.data));
  source.onerror = () => {
    document.getElementById("conn").classList.add("off");
    source.close();
    setTimeout(connect, 2000);
  };
}
connect();
</script>
</body>
</html>
`
