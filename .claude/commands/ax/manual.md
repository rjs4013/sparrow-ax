---
description: 사람이 이미 고친 변경의 반영 — 기준점과의 차이를 읽고 정리(manual)
argument-hint: "[기준 커밋]"
---
`AGENTS.md`와 `docs/agent/pipelines.md`를 읽고 **manual 경로**로 수행한다. 기준점(기본: 직전 커밋 `HEAD`, 인자가 있으면 그 커밋)과 현재 작업 트리의 차이를 읽고, 가벼운 검토 후 기능 단위로 정리해 커밋한다. 변경의 의도를 역추론해 향후 규칙으로 삼을지 제안한다. 문서와 코드의 불일치를 발견하면 보고한다.

기준점: $ARGUMENTS
