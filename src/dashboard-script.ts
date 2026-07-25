/**
 * Client JS body for the panel page (no <script> tags) — evaluated raw in the browser and, in tests,
 * via `new Function("document", "EventSource", DASHBOARD_SCRIPT)` against a DOM stub.
 *
 * The client is deliberately dumb (plan D2): it renders the server-computed `PanelSnapshot`
 * unconditionally — meta, phase label, runs, checks, failures, PR — with ZERO branching on
 * `phaseKey`, so no phase can ever lose its runs or PR again. All user-controlled fields go
 * through `esc()`. `render()` only ever touches `#app` and `#hidden` (plan D7); the filtering
 * itself (`buildControls`, `filterSnapshot`, `filterActive`) lives in DASHBOARD_CONTROLS, hoisted
 * into the shared scope by the composed <script>.
 */
export const DASHBOARD_SCRIPT = `const ICONS = { queued: "…", in_progress: "◐", completed: "" };
let chrome = null;
let lastSnapshot = null;
function esc(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}
function runRow(run) {
  const icon = run.status === "in_progress" ? '<span class="spin">◐</span>' : (ICONS[run.status] ?? "");
  return '<div class="run">' + icon + '<a href="' + esc(run.url) + '" target="_blank">'
    + esc(run.name) + '</a><span class="state ' + esc(run.state) + '">' + esc(run.state) + "</span></div>";
}
function checkRow(check) {
  const name = check.url
    ? '<a href="' + esc(check.url) + '" target="_blank">' + esc(check.name) + "</a>"
    : esc(check.name);
  return '<div class="check">' + name
    + '<span class="state ' + esc(check.state) + '">' + esc(check.state) + "</span></div>";
}
function failureRow(failure) {
  return "<details><summary>" + esc(failure.runName) + "</summary><pre>" + esc(failure.logTail) + "</pre></details>";
}
function prView(pr) {
  let html = '<div class="pr">PR <a href="' + esc(pr.url) + '" target="_blank">#' + esc(pr.number)
    + " — " + esc(pr.title) + "</a>"
    + '<div class="verdict ' + (pr.ready ? "ready" : "blocked") + '">' + esc(pr.verdictLabel) + "</div>";
  if (pr.blockers.length > 0) {
    html += '<ul class="blockers">' + pr.blockers.map((blocker) => "<li>" + esc(blocker) + "</li>").join("") + "</ul>";
  }
  if (pr.draftLabel !== null) html += '<span class="badge off">' + esc(pr.draftLabel) + "</span>";
  return html + "</div>";
}
function watchView(watch) {
  return '<div class="watch"><div class="watch-meta">' + esc(watch.meta) + "</div>"
    + '<div class="phase ' + esc(watch.tone) + '">' + esc(watch.phaseLabel) + "</div>"
    + watch.runs.map(runRow).join("")
    + watch.checks.map(checkRow).join("")
    + watch.failures.map(failureRow).join("")
    + (watch.pr ? prView(watch.pr) : "")
    + "</div>";
}
function sessionView(session) {
  const badge = session.enabled
    ? '<span class="badge on">' + esc(chrome.watchOn) + "</span>"
    : '<span class="badge off">' + esc(chrome.watchOff) + "</span>";
  const project = session.projectLabel
    ? '<span class="project" title="' + esc(session.directory || "") + '">' + esc(session.projectLabel) + "</span>"
    : "";
  return '<div class="session"><div class="session-head"><span>' + project
    + '<span class="session-title">' + esc(session.title ?? session.sessionID) + "</span> "
    + '<span class="session-id">' + esc(session.sessionID) + "</span></span>" + badge + "</div>"
    + session.watches.map(watchView).join("") + "</div>";
}
function applyChrome(next) {
  chrome = next;
  document.title = next.pageTitle;
  document.getElementById("title").textContent = next.pageTitle;
}
function render(snapshot) {
  lastSnapshot = snapshot;
  applyChrome(snapshot.chrome);
  buildControls(snapshot.chrome);
  const app = document.getElementById("app");
  const hidden = document.getElementById("hidden");
  if (snapshot.sessions.length === 0) {
    hidden.textContent = "";
    app.innerHTML = '<div class="empty">' + esc(snapshot.chrome.emptyWaiting) + "</div>";
    return;
  }
  const filtered = filterSnapshot(snapshot, { query, phases, enabled });
  hidden.textContent = filterActive()
    ? snapshot.chrome.hiddenTemplate.replace("{n}", String(filtered.hidden))
    : "";
  app.innerHTML = filtered.sessions.length === 0
    ? '<div class="empty">' + esc(snapshot.chrome.noMatches) + "</div>"
    : filtered.sessions.map(sessionView).join("");
}
function connect() {
  const source = new EventSource("/panel/events");
  source.onopen = () => document.getElementById("conn").classList.remove("off");
  source.onmessage = (event) => render(JSON.parse(event.data));
  source.onerror = () => {
    document.getElementById("conn").classList.add("off");
    source.close();
    setTimeout(connect, 2000);
  };
}
connect();
`
