#!/usr/bin/env bash
# 게이트 단일 진입점. 에이전트와 (생기면) CI가 같은 스크립트를 부른다.
# "건너뜀"은 통과 증거가 아니다. 종료 코드 0은 실행된 게이트가 모두 통과했다는 뜻이다.
set -u
cd "$(dirname "$0")/.."
status=0

bash scripts/gate-docs.sh || status=1
node scripts/gate-risk.mjs   # 정보 출력용. 종료 코드에 영향을 주지 않는다.

if [ -f package.json ]; then
  for step in build lint test; do
    if node -e "process.exit(require('./package.json').scripts?.['$step'] ? 0 : 1)"; then
      echo "[gate] npm run $step"
      npm run "$step" --silent || status=1
    else
      echo "[gate] 건너뜀: package.json에 '$step' 스크립트 없음 (착수 단계에서 정의)"
    fi
  done
else
  echo "[gate] 건너뜀: 코드 없음(package.json 없음). 빌드 · 린트 · 테스트 · 보안 스캔은 착수 단계에서 구성"
fi

if [ "$status" -eq 0 ]; then echo "[gate] 실행된 게이트 통과"; else echo "[gate] 실패"; fi
exit $status
