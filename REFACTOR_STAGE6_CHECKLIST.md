# Refactor Stage 6 Checklist

마무리 단계(정리/문서화/안정화) 체크리스트입니다.

## Dead Code / 중복 정리

- [x] 공통 정책 모듈로 통합된 로직의 중복 구현 제거 유지 확인
- [x] `src/cli/common/tmux.ts`에서 미사용 공통 export(`buildExportPrefix`) 정리

## 모듈 경계 문서화

- [x] 모듈 경계 문서 추가: `docs/architecture/MODULE_BOUNDARIES.md`
- [x] 한국어 모듈 경계 문서 추가: `docs/architecture/MODULE_BOUNDARIES.ko.md`
- [x] README 링크 추가:
  - `README.md`
  - `README.ko.md`
  - `docs/README.ko.md`

## 회귀 테스트/안정화

- [x] `npm test` 통과
- [x] `npm run typecheck` 실행 (기존 알려진 파일 외 신규 에러 없음)

## Known Existing Issues

- [ ] `src/opencode/plugin/agent-opencode-bridge-plugin.ts`의 implicit `any` 타입 이슈는 기존 이슈로 별도 처리
