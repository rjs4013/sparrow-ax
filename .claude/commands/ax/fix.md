---
description: 버그 · 간단한 개선 — 문서화는 줄이고 테스트와 검토는 유지(fix)
argument-hint: "<증상 또는 요청>"
---
`AGENTS.md`와 `docs/agent/pipelines.md`를 읽고 **fix 경로**로 아래 작업을 수행한다. 접수는 `docs/agent/intake.md`, 환경 절차는 `docs/agent/environment.md`, 산출 · 환류는 `docs/agent/delivery.md`를 따른다. 근본 원인 → 호출자 전체 확인 → 공유 지점 한 곳 수정 → 실패를 재현하는 테스트 1개.

요청: $ARGUMENTS
