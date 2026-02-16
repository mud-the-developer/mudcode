# 모듈 경계 가이드

이 문서는 리팩토링 6단계에서 정리한 아키텍처 경계를 설명합니다.

## 의존 방향

아래 단방향 의존을 유지합니다.

`bin/discode.ts` -> `src/cli/**` -> `src/app/**` -> `src/{bridge,state,tmux,discord,agents,infra}`

규칙:

- `src/cli/**`: 인자 파싱, 프롬프트, 사용자 출력 담당
- `src/app/**`: 여러 CLI 명령이 공유하는 유스케이스 오케스트레이션 담당
- `src/bridge/**`: daemon 런타임(메시지 라우팅, hook 서버, bootstrap, pending reaction) 담당
- `src/policy/**`: CLI/app/bridge에서 공통으로 쓰는 규칙 담당
- `src/infra/**`: 셸 이스케이프, 스토리지, 환경 접근 같은 저수준 유틸 담당

## Policy 모듈

- `src/policy/window-naming.ts`
  - `toSharedWindowName`
  - `toProjectScopedName`
  - `resolveProjectWindowName`
- `src/policy/agent-launch.ts`
  - `buildExportPrefix`
  - `buildAgentLaunchEnv`
  - `withClaudePluginDir`
- `src/policy/agent-integration.ts`
  - `installAgentIntegration`

공통 동작은 위 policy 모듈을 단일 소스로 사용합니다.

## 변경 가이드

변경 시 체크:

1. CLI와 bridge가 함께 쓰는 로직이면 `src/policy/**`로 이동
2. tmux/Discord/fs/process 같은 부작용은 policy에 두지 않기
3. 변경한 동작에 맞는 테스트를 `tests/policy/**` 또는 기존 흐름 테스트에 추가
4. `src/cli/**`를 non-CLI 레이어에서 import하지 않기

## 검증 체크리스트

- `npm test` 통과
- `npm run typecheck`에서 기존 알려진 이슈 외 신규 에러 없음
- 핵심 흐름(`new`, `attach`, `stop`, bridge start/stop/event) 동작 유지
