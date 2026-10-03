# CI Loop OpenChamber rail design system

## 1. Atmosphere & Identity

A compact, dependable CI instrument inside OpenChamber, not a separate website. The distinctive move is an **evidence ledger**: each watch leads with its phase and repository context, then shows runs, external checks, failure evidence, and PR blockers in their actual order of use. The host supplies the visual identity and theme. Avoid a second brand, decorative status lights, fake metrics, or oversized cards. Audience: developers inspecting several sessions; the rail's job is to identify the failing watch, inspect its evidence, and change a session's watch setting safely.

Two layouts considered: (A) card-per-run tiles waste rail width and hide PR blockers below repeated chrome; (B) session groups containing compact, readable watch ledgers keep related evidence together. Use B. This is deliberately denser than a generic dashboard but has stable whitespace and full-width failure disclosures.

## 2. Color

The host owns light and dark values. `applyHostReady` writes these aliases; **no local palette literals or alternate theme**. The six color roles below are the compact palette, each resolved by OpenChamber for the current theme:

| Role | Host tokens | Usage |
| --- | --- | --- |
| Canvas / raised | `--oc-bg`, `--oc-elevated`, `--oc-muted-surface`, `--oc-subtle` | Frame, group, quiet evidence surface |
| Ink / support | `--oc-fg`, `--oc-muted`, `--oc-elevated-fg` | Content, IDs, repository metadata |
| Rules / response | `--oc-border`, `--oc-hover`, `--oc-active`, `--oc-focus` | Separators, affordance, keyboard focus |
| Action | `--oc-primary`, `--oc-primary-fg`, `--oc-primary-text` | Action and safe external links |
| Success / information | `--oc-success-text`, `--oc-info-text` | Successful and in-progress evidence |
| Attention / failure | `--oc-warning-text`, `--oc-error-text` | Blocked PR and failed CI |

Never use a colored accent border to mark selection. Filter state uses host selection/active wash and `aria-pressed`; tones belong on the content label, not the entire card. SDK banner and switch own their own host-token theming.

## 3. Typography

| Role | Scale | Weight / line | Usage |
| --- | --- | --- | --- |
| Title | 16px | 600 / 1.35 | Rail heading |
| Row primary | 14px | 600 / 1.45 | Session title, failure run, PR link |
| Body | 14px | 400 / 1.45 | Runs, checks, blockers, controls |
| Meta | 12px | 400 / 1.45 | Project, ID, watch meta, status detail |
| Code | 12px | 400 / 1.5 | Log tail, with preserved whitespace and wrapping |

Use `--oc-font` for the inherited host family, and `--oc-mono` only for logs and session IDs. No remote fonts. Keep full labels accessible while visible lines wrap or truncate purposefully.

## 4. Spacing & Layout

Four-pixel base: 4 / 8 / 12 / 16 / 20 / 24 / 32px. One-pixel borders are hairline mechanics, not a spacing step. Frame inset 12px; section spacing 12px; internal row spacing 8px; compact inline gap 4px. Content measure is at most 760px in an unusually wide frame. The filter bar is a wrapping cluster, not a horizontally scrolling carousel. At ~320px, the search field uses the full width, chips wrap, and names/URLs can break without expanding the frame.

Spatial contract: [StyleGallery scroll-body-shell](https://github.com/changeroa/StyleGallery/blob/main/patterns/viewport-shell/scroll-body-shell.md). The root is a bounded `100dvb` grid: stable title, connection and filters above; **the session list alone owns vertical scroll**, with `min-block-size: 0`. No nested vertical scrollbar; open logs wrap inside the same scroll owner. DOM order matches reading and tab order.

Content jobs, in order: connection (trust), search/filters (navigate), session heading/switch (identify/act), watch phase (triage), runs/checks (prove), failure logs (diagnose), PR blockers (decide). No content block exists just to balance a composition.

## 5. Components

### Connection notice
- Structure: persistent region mounted with SDK `mountBanner`, fed by `describeConnection`.
- States: live is compact, polling is explicit, connecting/unavailable/forbidden/invalid-data are distinct; stale snapshot is always labeled. Never present offline as healthy empty data.
- Layout: above scroll owner. Accessibility: `role=status` or banner semantics from SDK; language follows binding locale.

### Filter cluster
- Structure: persistent SDK `mountTextField` search with visible `filtersLabel`; eight native buttons in `PANEL_PHASE_KEYS` order, tri-state enabled button, clear button, hidden counter.
- States: debounced text, multi-phase `aria-pressed`, all → on → off, clear, no-matches. Selected chip uses `--oc-selection`; focus-visible uses `--oc-focus`. Buttons stay mounted across snapshots to preserve caret/focus.
- Layout: wrapping cluster above scroll. Accessibility: native button keyboard operation and named search.

### Session group
- Structure: project label and title (ID falls back as title), muted ID, SDK `mountSwitch`, local SDK error banner with retry, keyed watch list.
- States: authoritative checked value, pending disabled without optimistic flip, failed write locally explained, retry, stale/forbidden disabled, SSE reconciliation.
- Layout: vertical stack with compact header; same key (`sessionID`) across frames. Accessibility: switch includes the session name; error appears next to it.

### Watch ledger
- Structure: metadata, phase badge or label with `tone`, every run/status, external check/status, stable native `<details>` per failure, PR number/title link, verdict, all blockers, draft label.
- States: phase tone (info/ok/fail/warn), expandable log (persists across frames), safe-link fallback to plain text when URL is not HTTP(S).
- Layout: one stack per watch, keyed by `watch.key`; rows wrap long text. Accessibility: semantic list, summary, link-like buttons only for valid URLs; no hidden blocker truncation.

### Empty/read-only state
- Structure: SDK `mountEmpty` for no sessions or no matches, SDK banner for offline/forbidden; never conflate the three.
- States: waiting for a push, filtered-out content, no current data while unreachable.
- Layout: fills available list region without a fake metric card.

## 6. Motion & Interaction

The rail is operational: no autoplay or decorative movement. SDK switch/thumb follows its built-in press feedback (beui switch consulted for same-frame state feedback); failure disclosure uses native `<details>` (beui accordion consulted for continuity, but native disclosure avoids layout-jank and preserves identity). On press, the control acknowledges immediately; async writes show disabled pending, success is the authoritative value, failure is local with retry. Color wash transitions, if any, are SDK-owned; do not animate geometry. `prefers-reduced-motion` is inherited by SDK/native behavior.

## 7. Depth & Surface

Mixed host-native tonal shift plus sparse border: `--oc-bg` canvas, `--oc-elevated` session groups, `--oc-muted-surface` only for nested log context; `--oc-border` separates evidence groups. No added shadow/glow. Radius: `--oc-radius` for groups/fields, smaller nested radius via `calc(var(--oc-radius) - 4px)` when needed, full pill for chips. Existing SDK primitives own their corner and elevation recipe.

## 8. Accessibility Constraints & Accepted Debt

Target WCAG 2.2 AA: 4.5:1 body, 3:1 non-text state indicators, visible focus, fully keyboard-operable chips/switch/details/links, 200% zoom and ~320px rail, both host themes, long strings and multiline logs, screen-reader state labels and local errors. Status text accompanies color. No optimistic state that could mislead someone relying on switch semantics. Host chrome supplies locale-specific strings; extension-only errors have en/pt-BR equivalents. External URLs are validated before being offered.

Accepted debt: none. Real-stack iframe and production Lighthouse measurements belong to Task 13; Task 10 uses a disposable rich-snapshot rail harness when the SDK handshake permits it. Record any unverified claim in the Task 10 handoff, not as an accepted accessibility exception.
