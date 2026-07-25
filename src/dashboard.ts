import { DASHBOARD_SCRIPT } from "./dashboard-script.ts"
import { DASHBOARD_STYLES } from "./dashboard-styles.ts"

/**
 * Single-page CI dashboard — consumes /panel/events (SSE) and renders the server view model.
 * Zero hardcoded user-facing text: the chrome (title, labels, empty state) arrives with the
 * first SSE frame. `#controls` is a static placeholder the controls script (T9) fills once.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title></title>
<style>
${DASHBOARD_STYLES}</style>
</head>
<body>
<h1><span class="dot" id="conn"></span><span id="title"></span></h1>
<div id="controls"></div>
<div id="app"></div>
<script>
${DASHBOARD_SCRIPT}</script>
</body>
</html>
`
