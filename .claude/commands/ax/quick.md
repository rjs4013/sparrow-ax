---
description: 작고 위험이 낮은 수정 — 최소 diff와 게이트만(quick)
argument-hint: "<요청>"
---
`AGENTS.md`와 `docs/agent/pipelines.md`를 읽고 **quick 경로**로 아래 작업을 수행한다. 작업 브랜치부터 확보하고(`docs/agent/environment.md`), 최소 diff로 고친 뒤 `bash scripts/gate.sh`를 돌린다. 위험 신호(`docs/agent/risk-signals.md`)가 감지되면 멈추고 승격을 알린다.

요청: $ARGUMENTS
