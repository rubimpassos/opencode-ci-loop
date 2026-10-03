# CI Loop Work Status: design-system supplement

This compact chat section follows the repository's root `DESIGN.md` host-token palette. Unlike the full rail, Work Status already has a title, container, and scroll owner; the iframe contributes **only** the current chat's switch and short CI summary. [StyleGallery box](https://github.com/changeroa/StyleGallery/blob/main/patterns/containment/box.md) guides its intrinsic layout: one flow container with predictable 4px padding, no nested card, no independent scroll below 320px. The host clamps height between 24 and 320px.

## Color, typography, and surface

- Host `applyHostReady` supplies `--oc-bg`, `--oc-fg`, `--oc-muted`, `--oc-info-text`, `--oc-success-text`, `--oc-warning-text`, `--oc-error-text`, `--oc-font`, and SDK control colors. No static theme colors or extra fonts.
- The iframe document and content use `--oc-bg` to match the host-colored canvas even under dark color-scheme. No inner border, shadow, or added radius.
- SDK `mountSwitch` owns the 14px accessible label and 12px description, its thumb and focus ring. The summary is 12px tabular text with the SDK phase badge (11px) and semantic PR text; wrap long blockers, never hide them behind a fixed-width line.
- Layout: 4px baseline; 8px between switch and summary; summary rows 4px apart. CI state is supplied by the plugin's tone, with text communicating the same meaning without color.

## Components and states

- **Switch**: current `onSession` ID only. No chat → no switch and a no-chat note. New chat absent from snapshot → disabled control during GET, then server's actual default. Existing chat without a watch → switch plus no-watch note. Pending POST → disabled, original checked value; confirmed POST → server's enabled value; failure → original value and inline alert + SDK retry button. Stale, offline, forbidden, and incompatible snapshots disable writes and display `describeConnection` rather than presenting a healthy no-watch state.
- **Readout**: phase badge, run progress/failed count, PR number/verdict, first blocker and localized `+N more`. Snapshot data is untrusted; write as text nodes, not HTML. PR/no-watch/no-chat are separate states. Changes to the readout announce politely, while failures alert immediately.
- **Sizing**: `ResizeObserver` measures actual content after each render, dedupes rounded, clamped height requests, and disconnects on disposal. The host Work Status panel owns scroll; text and rows reflow at mobile widths.

## Interaction and accessibility

Switch feedback follows the SDK's [beui-inspired switch mechanism](https://beui.dev/r/switch/raw): the thumb only travels after the authoritative server reply, with disabled feedback during latency. No other animated telemetry or decorative effects; reduced-motion suppresses thumb transitions without removing checked, focus, or error states. Keyboard action, `role=switch`, `aria-checked`, visible focus, inline `role=alert` and localized retry are SDK/native affordances. Target WCAG 2.2 AA and 200% zoom. Accepted debt: integrated host-frame Lighthouse and production screenshots are tracked by plan S4, not claimed by isolated unit tests.
