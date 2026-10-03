/** OpenChamber owns every theme value; the rail only provides layout and semantic placement. */
export const PANEL_STYLES = `
  *, *::before, *::after { box-sizing: border-box; }
  html, body, #root { margin: 0; min-inline-size: 0; block-size: 100%; }
  body { background: var(--oc-bg); color: var(--oc-fg); font: 14px/1.45 var(--oc-font); }
  button, input { font: inherit; }
  button { cursor: pointer; }
  [hidden] { display: none !important; }
  .ci-shell {
    display: grid;
    grid-template-rows: auto auto auto minmax(0, 1fr);
    block-size: 100dvb;
    min-inline-size: 0;
    gap: 12px;
    padding: 12px 12px 0;
  }
  .ci-shell > * { inline-size: min(100%, 760px); min-inline-size: 0; margin-inline: auto; }
  .ci-heading { margin-block: 0; font-size: 16px; line-height: 1.35; font-weight: 600; }
  .ci-connection { min-inline-size: 0; font-size: 12px; }
  .ci-connection[data-state="live"] { opacity: .88; }
  .ci-controls { display: grid; gap: 8px; min-inline-size: 0; }
  .ci-filters-title { margin: 0; font-size: 12px; font-weight: 600; line-height: 1.45; }
  .ci-search { min-inline-size: 0; }
  .ci-search .oc-sdk-field, .ci-search input { inline-size: 100%; min-inline-size: 0; }
  .ci-chips { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; min-inline-size: 0; }
  .ci-chip {
    min-block-size: 28px;
    max-inline-size: 100%;
    padding: 4px 8px;
    border: 1px solid var(--oc-border);
    border-radius: 999px;
    background: var(--oc-elevated);
    color: var(--oc-muted);
    font-size: 12px;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }
  .ci-chip:hover { background: var(--oc-hover); color: var(--oc-fg); }
  .ci-chip:active, .ci-chip[data-active="true"] {
    background: var(--oc-selection);
    color: var(--oc-selection-fg);
  }
  .ci-chip:focus-visible, .ci-link:focus-visible, .ci-failure > summary:focus-visible {
    outline: 2px solid var(--oc-focus);
    outline-offset: 2px;
  }
  .ci-clear { margin-inline-start: auto; }
  .ci-hidden { margin: 0; color: var(--oc-muted); font-size: 12px; }
  .ci-body { min-block-size: 0; overflow: auto; overscroll-behavior: contain; padding-block-end: 20px; }
  .ci-sessions { display: grid; gap: 12px; min-inline-size: 0; }
  .ci-session {
    min-inline-size: 0;
    padding: 12px;
    border: 1px solid var(--oc-border);
    border-radius: var(--oc-radius);
    background: var(--oc-elevated);
  }
  .ci-session-head { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 8px; }
  .ci-identity { display: flex; flex: 1 1 160px; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; min-inline-size: 0; }
  .ci-project { color: var(--oc-muted); font-size: 12px; font-weight: 600; overflow-wrap: anywhere; }
  .ci-session-title { flex: 1 1 100%; min-inline-size: 0; margin: 0; font-size: 14px; line-height: 1.45; font-weight: 600; overflow-wrap: anywhere; }
  .ci-session-title.ci-id-fallback { color: var(--oc-muted); font-family: var(--oc-mono); font-weight: 400; }
  .ci-session-id { color: var(--oc-muted); font: 12px/1.45 var(--oc-mono); overflow-wrap: anywhere; }
  .ci-switch { flex: 0 0 auto; max-inline-size: 100%; }
  .ci-session-error { margin-block-start: 8px; }
  .ci-retry { display: inline-flex; margin-block-start: 4px; }
  .ci-session-waiting { margin: 8px 0 0; color: var(--oc-muted); font-size: 12px; }
  .ci-watches { min-inline-size: 0; }
  .ci-watch { min-inline-size: 0; padding-block-start: 12px; margin-block-start: 12px; border-block-start: 1px solid var(--oc-border); }
  .ci-watch-meta { margin: 0 0 8px; color: var(--oc-muted); font-size: 12px; overflow-wrap: anywhere; }
  .ci-phase { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; margin-block-end: 8px; }
  .ci-failure-marker { color: var(--oc-error-text); font-size: 12px; font-weight: 600; }
  .ci-evidence-group { min-inline-size: 0; margin-block-start: 8px; }
  .ci-evidence-title { margin: 0 0 4px; color: var(--oc-muted); font-size: 12px; font-weight: 600; }
  .ci-evidence-list { display: grid; gap: 4px; min-inline-size: 0; margin: 0; padding: 0; list-style: none; }
  .ci-evidence { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 8px; min-inline-size: 0; padding: 4px 0; }
  .ci-external { min-inline-size: 0; overflow-wrap: anywhere; }
  .ci-link { border: 0; padding: 0; background: transparent; color: var(--oc-primary-text); text-align: start; text-decoration: underline; text-underline-offset: 2px; overflow-wrap: anywhere; }
  .ci-link:hover { color: var(--oc-primary); }
  .ci-link-error { display: block; color: var(--oc-error-text); font-size: 12px; }
  .ci-link-error:empty { display: none; }
  .ci-evidence-state { color: var(--oc-muted); font-size: 12px; overflow-wrap: anywhere; }
  .ci-evidence-state[data-tone="success"], .ci-verdict[data-tone="success"] { color: var(--oc-success-text); }
  .ci-evidence-state[data-tone="error"] { color: var(--oc-error-text); }
  .ci-evidence-state[data-tone="info"] { color: var(--oc-info-text); }
  .ci-verdict[data-tone="warning"] { color: var(--oc-warning-text); }
  .ci-failure { min-inline-size: 0; margin-block-start: 8px; }
  .ci-failure > summary { cursor: pointer; color: var(--oc-error-text); font-weight: 600; overflow-wrap: anywhere; }
  .ci-failure > summary:hover { text-decoration: underline; }
  .ci-log {
    max-inline-size: 100%;
    margin: 8px 0 0;
    padding: 8px;
    border: 1px solid var(--oc-border);
    border-radius: calc(var(--oc-radius) - 4px);
    background: var(--oc-muted-surface);
    color: var(--oc-fg);
    font: 12px/1.5 var(--oc-mono);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .ci-pr { min-inline-size: 0; margin-block-start: 12px; padding-block-start: 8px; border-block-start: 1px solid var(--oc-border); }
  .ci-pr-line { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 8px; min-inline-size: 0; }
  .ci-pr-label { color: var(--oc-muted); font-size: 12px; font-weight: 600; }
  .ci-draft { padding: 4px 8px; border-radius: 999px; background: var(--oc-muted-surface); color: var(--oc-muted); font-size: 12px; }
  .ci-verdict { margin: 8px 0 0; font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
  .ci-blockers { display: grid; gap: 4px; margin: 8px 0 0; padding-inline-start: 20px; color: var(--oc-fg); overflow-wrap: anywhere; }
  .ci-empty { min-inline-size: 0; padding-block: 20px; }
`
