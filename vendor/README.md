# Vendored OpenChamber SDK

`openchamber-sdk-loopback.tgz` is `@openchamber/sdk@2.1.1` packed from the OpenChamber fork, which adds the
guest loopback host API (`loopbackUrl`, `loopbackRequest`, `watchLoopback`) and the `loopback`
manifest contribution. Those APIs are not in a published SDK release yet; this archive is a
reversible stopgap until they are.

- Source: `packages/sdk` of the OpenChamber fork
- Commit: `02aa476b4a3c33eb856c3fb8d4921bd9a94b0587`
- SHA-256: `d0a181b24e5bc74013387b24b3970bf1055a2ded791700756b9d025888a33c50`
- License: MIT (see `package/LICENSE` inside the archive)

Build-only: it is a devDependency used to bundle `panel/`, `status/` and `background/`.
It is not part of the published plugin package and the plugin runtime never loads it.

Regenerate: `bun scripts/sync-openchamber-sdk.ts <openchamber checkout>`, then `bun install`.
