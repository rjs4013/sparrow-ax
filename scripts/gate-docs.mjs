// 문서 게이트 (결정적): 상대 링크와 백틱 안의 저장소 경로가 실제로 존재하는지 검사한다.
// 검사하지 않는 것: 앵커(#...), 외부 URL, `{ }` `< >` `*` 가 든 경로, '/'로 끝나는 디렉터리 경로.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const skipDirs = new Set(['.git', 'node_modules']);
const skipFiles = /^AGENT_BOOTSTRAP/; // 설치 원본(템플릿 예시 경로가 많다)
const pathCheckScope = /^(AGENTS\.md|CLAUDE\.md|docs\/agent\/|\.claude\/)/;

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (!skipDirs.has(name)) walk(p); }
    else if (name.endsWith('.md') && !skipFiles.test(name)) files.push(p);
  }
})(root);

const errors = [];
for (const file of files) {
  const rel = relative(root, file).replaceAll('\\', '/');
  const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, ''); // 코드 블록 제외

  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const path = decodeURI(target.split('#')[0]);
    if (!existsSync(resolve(dirname(file), path))) errors.push(`${rel}: 깨진 링크 → ${target}`);
  }

  if (!pathCheckScope.test(rel)) continue;
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const p = m[1];
    if (!/^(docs|scripts|\.claude)\/\S+$/.test(p) && !/^(AGENTS|CLAUDE)\.md$/.test(p)) continue;
    if (/[{}<>*]/.test(p) || p.endsWith('/')) continue;
    if (!existsSync(resolve(root, p))) errors.push(`${rel}: 존재하지 않는 경로 → ${p}`);
  }
}

if (errors.length) {
  console.error(`[gate-docs] 실패 (${errors.length}건)\n` + errors.map((e) => '  - ' + e).join('\n'));
  process.exit(1);
}
console.log(`[gate-docs] 통과: Markdown ${files.length}개 검사`);
