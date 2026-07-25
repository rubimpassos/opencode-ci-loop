/** Panel CSS — dark GitHub-ish visual language. Tones map phases: info=blue, ok=green, fail=red, warn=yellow. */
export const DASHBOARD_STYLES = `  :root {
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
  .session-title { color: var(--text); font-weight: 600; font-size: 13px; }
  .session-id { color: var(--muted); font-size: 11px; }
  .project { color: var(--text); font-size: 12px; font-weight: 600; margin-right: 8px; }
  .badge { border-radius: 999px; padding: 1px 10px; font-size: 12px; border: 1px solid var(--border); }
  .badge.on { color: var(--green); border-color: var(--green); }
  .badge.off { color: var(--muted); }
  .watch { margin-top: 10px; padding: 10px; border: 1px solid var(--border); border-radius: 6px; }
  .watch + .watch { margin-top: 8px; }
  .watch-meta { color: var(--muted); font-size: 12px; margin-bottom: 8px; }
  .phase { font-weight: 600; }
  .phase.info { color: var(--blue); }
  .phase.ok { color: var(--green); }
  .phase.fail { color: var(--red); }
  .phase.warn { color: var(--yellow); }
  .run, .check { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
  .run a, .check a { color: var(--text); text-decoration: none; }
  .run a:hover, .check a:hover { text-decoration: underline; }
  .run .state, .check .state { margin-left: auto; font-size: 12px; }
  .state.success { color: var(--green); }
  .state.failure, .state.timed_out, .state.startup_failure, .state.failing { color: var(--red); }
  .state.cancelled, .state.skipped { color: var(--yellow); }
  .state.queued, .state.in_progress, .state.pending { color: var(--blue); }
  .spin { display: inline-block; animation: spin 1.2s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  pre { background: #010409; border: 1px solid var(--border); border-radius: 6px; padding: 10px;
    overflow-x: auto; font-size: 12px; max-height: 320px; }
  details summary { cursor: pointer; color: var(--red); margin-top: 8px; }
  .pr { border-top: 1px solid var(--border); margin-top: 8px; padding-top: 8px; font-size: 12px; }
  .pr a { color: var(--blue); text-decoration: none; }
  .pr a:hover { text-decoration: underline; }
  .verdict.ready { color: var(--green); }
  .verdict.blocked { color: var(--yellow); }
  .blockers { margin: 4px 0 0; padding-left: 16px; color: var(--muted); }
`
