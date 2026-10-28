# 환경: 원격 VCS

- 저장소: Git, `origin` = `https://github.com/rjs4013/sparrow-ax.git`, 기준 브랜치 `master`.
- 코어 경로가 환경에 요구하는 것: **변경을 분리한다 / 되돌린다 / 검토를 요청한다.**

| 요구 | 수단 |
|---|---|
| 변경 분리 | 지시서 ID가 들어간 브랜치 `{type}/{ID}-{요약}` |
| 되돌리기 | 되돌림 커밋 (`git revert <커밋>`). 이력 재작성은 하지 않는다 |
| 검토 요청 | 브랜치 커밋까지가 에이전트의 종료 지점. push · PR은 사람이 한다 (`gh` CLI는 설치되어 있지 않다) |

## 시작 절차
1. 작업 트리가 깨끗한지 확인한다 (`git status --short`). 사람의 미커밋 변경이 있으면 섞지 않는다 — 멈추고 묻는다 (`manual`의 대상일 수 있다).
2. `git fetch origin` 후 `master`를 기준으로 `{type}/{ID}-{요약}` 브랜치를 만든다. 병렬 세션은 작업 트리를 분리한다(worktree).
3. 커밋 메시지는 한글, 지시서 ID로 시작한다 (기존 관례: 한글 한 줄 메시지). 기능 단위로 나누어 커밋한다.
4. 머지는 사람이 하며 `--no-ff`를 쓴다.

## 하지 않는 것 (사람 확인)
`git push`(특히 force), `reset --hard`, `rebase`, `commit --amend`, `clean`, `branch -D`. `.claude/settings.json`이 push는 확인을 요구하고 force push는 거부한다.

## 게이트
`bash scripts/gate.sh`. CI는 아직 없다. CI가 생기면 같은 스크립트를 부른다. CI가 없는 동안 로컬 게이트가 유일한 게이트이므로, 검증자의 증거(명령과 결과)를 작업 기록에 반드시 남긴다.
