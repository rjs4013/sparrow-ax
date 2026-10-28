#!/usr/bin/env bash
# 문서 게이트: Markdown 상대 링크와 문서에 적힌 저장소 경로가 실제로 존재하는지 검사한다.
set -u
cd "$(dirname "$0")/.."
exec node scripts/gate-docs.mjs
