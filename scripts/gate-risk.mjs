// 위험 신호 감지 (결정적, 정보 출력용): docs/agent/risk-signals.md 표의 '감지 규칙' 열에 있는
// 백틱 글롭을 읽어, 변경된 파일(master 대비 + 미커밋 + 신규)에 대어 본다. 종료 코드는 항상 0이다.
// 사용: node scripts/gate-risk.mjs [파일...]   (인자가 있으면 git 대신 그 파일들을 검사)
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { matchesGlob, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const git = (...args) => {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }); } catch { return ''; }
};

const signals = [];
for (const line of readFileSync(resolve(root, 'docs/agent/risk-signals.md'), 'utf8').split('\n')) {
  if (!line.startsWith('|')) continue;
  const cells = line.split('|').map((c) => c.trim()).slice(1, -1);
  if (cells.length < 3 || cells[0] === '신호' || /^-+$/.test(cells[0])) continue;
  const globs = [...cells[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((g) => /[*.\/]/.test(g) && !/\s/.test(g));
  if (cells[1].startsWith('(글롭 없음)') || !globs.length) continue;
  signals.push({ name: cells[0], globs, action: cells[2] });
}

let changed = process.argv.slice(2);
if (!changed.length) {
  const base = git('merge-base', 'HEAD', 'master').trim() || 'HEAD';
  changed = [
    ...git('diff', '--name-only', base).split('\n'),
    ...git('ls-files', '--others', '--exclude-standard').split('\n'),
  ].filter(Boolean);
  changed = [...new Set(changed)];
}

const hits = [];
for (const s of signals) {
  const files = changed.filter((f) => s.globs.some((g) => matchesGlob(f, g)));
  if (files.length) hits.push({ ...s, files });
}

if (!hits.length) console.log(`[gate-risk] 감지된 위험 신호 없음 (변경 ${changed.length}개 파일 검사)`);
for (const h of hits) {
  console.log(`[gate-risk] 감지: ${h.name} → ${h.action}\n             ${h.files.join(', ')}`);
}
