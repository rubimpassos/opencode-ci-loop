import { PANEL_PHASE_KEYS } from "./panel-types.ts"

/**
 * Controls half of the client JS (no <script> tags) — appended after DASHBOARD_SCRIPT inside the
 * ONE <script>, sharing its module scope (`esc`, `render`, `panelChrome`, `lastSnapshot`).
 *
 * Plan D7: `#controls` is filled exactly once (the `controlsBuilt` guard) and never reassigned;
 * filter state lives in module vars and every control change re-runs `render(lastSnapshot)`
 * locally, so the search input node — and its focus/caret — survive SSE re-renders by construction.
 * Plan D8: the unit of filtering is the watch row; search AND phase AND enabled combine. The query
 * is only ever used for substring matching against the server-built `searchText` — it is NEVER
 * written into innerHTML, so search cannot become an XSS vector.
 */
export const DASHBOARD_CONTROLS = `const PHASE_KEYS = ${JSON.stringify(PANEL_PHASE_KEYS)};
let controlsBuilt = false;
let query = "";
const phases = new Set();
let enabled = "all";
let debounceId = 0;
function filterActive() {
  return query !== "" || phases.size > 0 || enabled !== "all";
}
function enabledLabel() {
  return {
    all: panelChrome.filterEnabledAll,
    on: panelChrome.filterEnabledOn,
    off: panelChrome.filterEnabledOff,
  }[enabled];
}
function filterSnapshot(snapshot, state) {
  const sessions = [];
  let baseline = 0;
  let visible = 0;
  for (const session of snapshot.sessions) {
    baseline += session.watches.length > 0 ? session.watches.length : 1;
    if (state.enabled !== "all" && state.enabled !== (session.enabled ? "on" : "off")) continue;
    if (session.watches.length === 0) {
      if (state.phases.size === 0 && session.searchText.includes(state.query)) {
        sessions.push(session);
        visible += 1;
      }
      continue;
    }
    const watches = session.watches.filter((watch) =>
      (state.phases.size === 0 || state.phases.has(watch.phaseKey)) && watch.searchText.includes(state.query));
    if (watches.length > 0) {
      sessions.push({ ...session, watches });
      visible += watches.length;
    }
  }
  return { sessions, hidden: baseline - visible };
}
function buildControls(nextChrome) {
  if (controlsBuilt) return;
  controlsBuilt = true;
  const chips = PHASE_KEYS.map((key) =>
    '<span class="chip" id="chip-' + key + '">' + esc(nextChrome.phaseChips[key]) + "</span>").join("");
  document.getElementById("controls").innerHTML =
    '<input id="search" type="search" placeholder="' + esc(nextChrome.searchPlaceholder) + '" />' + chips
    + '<span class="chip" id="chip-enabled">' + esc(enabledLabel()) + "</span>"
    + '<span class="chip" id="chip-clear">' + esc(nextChrome.clearFilters) + "</span>";
  const search = document.getElementById("search");
  const enabledChip = document.getElementById("chip-enabled");
  search.addEventListener("input", () => {
    clearTimeout(debounceId);
    debounceId = setTimeout(() => {
      query = search.value.toLowerCase();
      render(lastSnapshot);
    }, 150);
  });
  for (const key of PHASE_KEYS) {
    const chip = document.getElementById("chip-" + key);
    chip.addEventListener("click", () => {
      if (phases.has(key)) phases.delete(key); else phases.add(key);
      chip.classList[phases.has(key) ? "add" : "remove"]("active");
      render(lastSnapshot);
    });
  }
  enabledChip.addEventListener("click", () => {
    enabled = { all: "on", on: "off", off: "all" }[enabled];
    enabledChip.textContent = enabledLabel();
    enabledChip.classList[enabled === "all" ? "remove" : "add"]("active");
    render(lastSnapshot);
  });
  document.getElementById("chip-clear").addEventListener("click", () => {
    query = "";
    search.value = "";
    phases.clear();
    enabled = "all";
    enabledChip.textContent = enabledLabel();
    enabledChip.classList.remove("active");
    for (const key of PHASE_KEYS) document.getElementById("chip-" + key).classList.remove("active");
    render(lastSnapshot);
  });
}
`
