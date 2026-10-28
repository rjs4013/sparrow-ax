---
description: 문서가 주 산출물인 작업 — 작성, 문서 게이트, 사실 대조(docs)
argument-hint: "<요청> 또는 @문서경로"
---
`AGENTS.md`와 `docs/agent/pipelines.md`를 읽고 **docs 경로**로 아래 작업을 수행한다. 접수는 `docs/agent/intake.md`, 산출 · 환류는 `docs/agent/delivery.md`를 따른다. 문서 게이트는 `bash scripts/gate-docs.sh`. 요구사항 원본 문서는 사람이 요청한 경우에만 고치고, 작업 중 코드 결함을 발견하면 고치지 말고 별도 지시서를 제안한다.

요청: $ARGUMENTS
