# opencode-ci-loop

Plugin de **CI validation loop** para o [opencode](https://opencode.ai) — o equivalente ao loop de validação do Claude Code desktop.

Depois que o agente roda `git push`, o plugin vigia o GitHub Actions e **injeta o resultado do CI (incluindo logs de falha) de volta na sessão** para o agente reagir autonomamente. Com toggle por sessão e dashboard visual ao vivo.

## Features

- **Detecção de push**: hook `tool.execute.after` detecta `git push` executado pelo agente
- **Watch do CI**: poll via `gh run list --commit <sha>` até todos os workflows concluírem
- **Injeção de contexto**: ao concluir, injeta relatório na sessão via `session.prompt` — CI verde vira noop, CI vermelho vira instrução de correção com o tail dos logs de falha
- **Toggle por sessão**: tool `ci_watch` (`enable` / `disable` / `status`) — peça ao agente "desliga o ci loop" a qualquer momento
- **Toasts na TUI**: transições `Aguardando CI…` → `CI: 1/2 completed` → `CI verde/com falhas`
- **Dashboard visual**: mini servidor HTTP+SSE (`http://127.0.0.1:4517`) com painel ao vivo — abra no painel browser do OpenChamber para ter a experiência "Claude Desktop"
- **Fork-aware**: resolve o repo do push via `@{push}` (o `gh` sozinho resolve pro remote `upstream` em forks e não acha os runs)

## Requisitos

- [GitHub CLI (`gh`)](https://cli.github.com/) autenticado
- Git

## Instalação

No `opencode.json`:

```json
{
  "plugin": ["opencode-ci-loop@git+https://github.com/rubimpassos/opencode-ci-loop.git"]
}
```

Ou com opções:

```json
{
  "plugin": [
    ["opencode-ci-loop@git+https://github.com/rubimpassos/opencode-ci-loop.git", {
      "autoWatch": true,
      "pollIntervalMs": 15000,
      "timeoutMs": 1800000,
      "failLogLines": 80,
      "dashboard": { "enabled": true, "host": "127.0.0.1", "port": 4517 }
    }]
  ]
}
```

| Opção | Default | Descrição |
|---|---|---|
| `autoWatch` | `true` | Estado inicial do loop em cada sessão |
| `pollIntervalMs` | `15000` | Intervalo de poll do `gh run list` |
| `initialDelayMs` | `5000` | Espera após o push antes do primeiro poll |
| `timeoutMs` | `1800000` (30min) | Tempo máximo vigiando um push |
| `failLogLines` | `80` | Linhas do tail de log por run com falha |
| `dashboard.enabled` | `true` | Liga o servidor do painel visual |
| `dashboard.port` | `4517` | Porta do painel |

## Uso

1. Peça ao agente para commitar e pushar — o loop dispara sozinho
2. Acompanhe pelos toasts ou pelo dashboard (`http://127.0.0.1:4517`)
3. CI falhou? O agente recebe o relatório com logs e corrige sem você pedir
4. "desliga o ci watch nesta sessão" → agente chama `ci_watch(action=disable)`

### Dashboard no OpenChamber

Abra `http://127.0.0.1:4517` no painel **browser/preview** do OpenChamber para ter o painel de CI ao vivo do lado do chat — status por workflow, spinner durante execução e logs de falha expansíveis.

## Desenvolvimento

```bash
bun install
bun run check   # typecheck + biome + testes
```

## Arquitetura

```
src/plugin.ts    # wiring: hooks, tool ci_watch, toasts, injeção de prompt
src/registry.ts  # estado por sessão + loop de watch (abortável)
src/gh.ts        # integração gh/git (exec injetável, fork-aware)
src/render.ts    # relatório markdown pro prompt + sumários
src/server.ts    # HTTP+SSE do dashboard
src/dashboard.ts # página do painel
```
