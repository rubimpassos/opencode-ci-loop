/** A transparent Work Status body; the host supplies chrome, fonts and every color. */
export const STATUS_CSS = `
:root {
  --status-space-1: 4px;
  --status-space-2: 8px;
  --status-space-3: 12px;
  --status-text-sm: .75rem;
}
* { box-sizing: border-box; }
html { background: var(--oc-bg); }
body { margin: 0; background: var(--oc-bg); color: var(--oc-fg); font: .875rem/1.45 var(--oc-font); }
[hidden] { display: none !important; }
.ci-status { display: flex; flex-direction: column; gap: var(--status-space-2); padding: var(--status-space-1); min-inline-size: 0; background: var(--oc-bg); }
.ci-status__switch { min-inline-size: 0; }
.ci-status__switch .oc-sdk-check { align-items: center; }
.ci-status__summary { display: flex; flex-direction: column; gap: var(--status-space-1); min-inline-size: 0; }
.ci-status__readout { display: flex; align-items: center; flex-wrap: wrap; gap: var(--status-space-1) var(--status-space-2); min-inline-size: 0; }
.ci-status__phase { min-inline-size: 0; }
.ci-status__phase .oc-sdk-badge { max-inline-size: 100%; white-space: normal; overflow-wrap: anywhere; }
.ci-status__metric { color: var(--oc-muted); font-size: var(--status-text-sm); font-variant-numeric: tabular-nums; }
.ci-status__note, .ci-status__connection, .ci-status__pr, .ci-status__blocker, .ci-status__error-text {
  margin: 0; min-inline-size: 0; overflow-wrap: anywhere; font-size: var(--status-text-sm);
}
.ci-status__note, .ci-status__blocker { color: var(--oc-muted); }
.ci-status__pr { color: var(--oc-muted); }
.ci-status__pr[data-ready="true"] { color: var(--oc-success-text); }
.ci-status__pr[data-ready="false"] { color: var(--oc-warning-text); }
.ci-status__connection[data-tone="info"] { color: var(--oc-info-text); }
.ci-status__connection[data-tone="warning"] { color: var(--oc-warning-text); }
.ci-status__connection[data-tone="error"] { color: var(--oc-error-text); }
.ci-status__error { display: flex; align-items: center; flex-wrap: wrap; gap: var(--status-space-1) var(--status-space-2); color: var(--oc-error-text); }
.ci-status__error-text { flex: 1 1 auto; }
@media (prefers-reduced-motion: reduce) {
  .ci-status .oc-sdk-check-thumb, .ci-status .oc-sdk-check-thumb::after { transition: none; }
}
` as const
