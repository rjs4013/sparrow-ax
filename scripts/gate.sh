#!/usr/bin/env bash
# 게이트 단일 진입점. 에이전트와 (생기면) CI가 같은 스크립트를 부른다.
# "건너뜀"은 통과 증거가 아니다. 종료 코드 0은 실행된 게이트가 모두 통과했다는 뜻이다.
set -u
cd "$(dirname "$0")/.."
status=0
skipped=0

bash scripts/gate-docs.sh || status=1
node scripts/gate-risk.mjs   # 정보 출력용. 종료 코드에 영향을 주지 않는다.

if [ -f package.json ]; then
  for step in build lint test; do
    if node -e "process.exit(require('./package.json').scripts?.['$step'] ? 0 : 1)"; then
      echo "[gate] npm run $step"
      npm run "$step" --silent || status=1
    else
      echo "[gate] 건너뜀: package.json에 '$step' 스크립트 없음 (착수 단계에서 정의)"; skipped=1
    fi
  done
  echo "[gate] npm audit (high 이상)"
  audit_out=$(npm audit --audit-level=high 2>&1); audit_rc=$?
  if [ "$audit_rc" -ne 0 ]; then
    # 취약점 보고서 본문에 'network' 같은 단어가 흔하므로 오류 코드로만 네트워크 실패를 판정한다.
    if echo "$audit_out" | grep -qE "ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH" \
       && ! echo "$audit_out" | grep -qiE "vulnerabilit"; then
      echo "[gate] 건너뜀: npm audit 네트워크 오류 (통과 증거 아님)"; skipped=1
    else
      echo "$audit_out"; status=1
    fi
  fi
else
  echo "[gate] 건너뜀: 코드 없음(package.json 없음). 빌드 · 린트 · 테스트 · 보안 스캔은 착수 단계에서 구성"; skipped=1
fi

if [ "$status" -ne 0 ]; then echo "[gate] 실패"
elif [ "$skipped" -eq 1 ]; then echo "[gate] 실행된 게이트 통과 (건너뜀 있음: 통과 증거 아님)"
else echo "[gate] 모든 게이트 통과"; fi
exit $status
