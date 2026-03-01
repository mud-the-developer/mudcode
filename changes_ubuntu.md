# Ubuntu 변경/디버깅 상세 기록 (Codex 캡처/Discord 출력)

작성 대상: `/home/super/yonsei/mud/mudcode`  
환경: Ubuntu PC, Discord 브릿지 + tmux 캡처 기반 Codex 연동

## 1) 문제 제기 및 목표

요청 핵심:
- Codex 작업 중간 상태(`Working ...`, `Adjusting query approach ...`, `esc to interrupt`, `› ...`)가 Discord로 계속 전송되는 문제 해결
- 원하는 동작은 "작업 완료 후 마지막 결과만" Discord에 1회 전송
- daemon restart 시 세션이 초기화되는 동작 변경
- 기본은 세션 유지 restart, 명시적 옵션에서만 세션 클리어
- 최종적으로 코드 반영 + 커밋/푸시

사용자가 제시한 실제 누수 예시:
- `• Working (0s • esc to interrupt)`
- `• Working (1s • esc to interrupt)` ...
- `• Adjusting query approach (14m 33s • esc to interrupt)` ...
- `› Write tests for @filename`

## 2) 원인 분석 (왜 이전 버전/다른 PC에서는 괜찮고 여기서만 재발했는지)

확인된 핵심 원인 2가지:

1. 캡처 필터 누락 케이스
- Codex TUI의 진행 상태/프롬프트 echo 라인이 다양한 포맷으로 렌더링됨
- 기존 필터가 일부 패턴(특히 `Adjusting ... (14m 33s • esc to interrupt)`와 `› ...`)을 완전히 커버하지 못함

2. final-only 모드의 flush 타이밍 문제
- `AGENT_DISCORD_CAPTURE_CODEX_FINAL_ONLY=1`이어도, 완료 감지(`markCompleted`) 직후 즉시 flush
- 이후에 들어오는 잔여 redraw delta가 별도 메시지로 추가 전송됨
- 결과적으로 "마지막 1개만 전송"이 깨지고, 완료 이후에도 조각 메시지 발생 가능

추가 운영 원인:
- daemon 재시작 시 환경변수 전달이 빠지면 final-only 자체가 꺼짐
- 즉, 코드가 맞아도 재시작 경로에서 env 미주입이면 중간 출력이 다시 나올 수 있음

## 3) 사용자 요청에 따라 먼저 반영된 변경 (commit: 41c9c00)

커밋:
- `41c9c005009c0ce875fe104fc59fd48151bd199d`
- 메시지: `fix: keep daemon restart sessions by default and tighten codex output filtering`

### 3-1. daemon restart 기본 정책 변경

수정 파일:
- `bin/mudcode.ts`

반영 내용:
- 인터랙티브 daemon 메뉴에서 restart를 명시적으로 분리
- 기본 restart는 세션 유지
- 세션 클리어는 별도 액션으로만 수행

변경 후 인터랙티브 메뉴:
- `1) status`
- `2) start`
- `3) restart (keep sessions)`
- `4) restart + clear managed tmux sessions`
- `5) stop`

### 3-2. Codex 중간 진행 상태 필터링 강화

수정 파일:
- `src/bridge/runtime/capture-poller.ts`
- `tests/bridge/capture-poller.test.ts`

주요 반영:
- `AGENT_DISCORD_CAPTURE_CODEX_FINAL_ONLY` 환경변수 지원
- `esc to interrupt` 포함 라인에 대한 강한 fallback 필터
- `› ...` 입력 라인 echo 제거
- Codex full-screen redraw 시 tail-anchor 안정성 개선
- Codex input-ready(`›` + footer) 감지로 완료 인식 보강
- prompt echo 정규화(`›` prefix 제거)로 매칭 정확도 향상

테스트 보강:
- `Working (...) esc to interrupt` 프레임 필터 테스트
- `Adjusting query approach (...) esc to interrupt` 필터 테스트
- `› Write tests for @filename` echo 필터 테스트
- redraw anchor 관련 회귀 테스트 다수 추가

## 4) 추가 이슈 재발 및 2차 수정 (commit: 4c2275f)

사용자 피드백:
- 필터를 넣었는데도 Discord에 중간 출력이 남아 나옴
- 특히 완료 직후에도 조각 출력이 보임

커밋:
- `4c2275f8df5454fa5e2ad56a51d365ef9d857f59`
- 메시지: `Fix codex final-only flush timing and channel retention`

수정 파일:
- `src/bridge/runtime/capture-poller.ts`
- `tests/bridge/capture-poller.test.ts`

핵심 수정점:

1. 버퍼 유지 조건 확장
- 기존: `pendingDepth > 0`일 때만 버퍼링
- 변경: 이미 버퍼가 존재하면 `pendingDepth = 0` 구간에서도 버퍼링 유지
- 목적: 완료 직후 잔여 redraw delta를 같은 최종 메시지에 흡수

2. 버퍼 채널(thread) 고정
- `bufferedOutputChannelByInstance` 추가
- 버퍼 시작 시 채널을 저장하고 flush 시 해당 채널로 일관 전송
- 목적: pending thread 경로를 잃어버려 다른 채널로 튀는 문제 방지

3. 조기 flush 제거
- `markCompleted` 직후 immediate flush 제거
- 최종 quiet poll에서 1회 flush
- 목적: 완료 감지 직후 발생하는 조각 메시지 전송 차단

4. 회귀 테스트 업데이트
- 기존 final-only 테스트를 확장해 완료 후 trailing delta(`step three`)까지 버퍼에 누적되는지 검증
- 최종 quiet poll에서 1회 전송되는지 검증

## 5) 실행/검증 내역

실행 검증:
- `npx vitest run tests/bridge/capture-poller.test.ts tests/bridge/capture-poller.replay.test.ts`
  - 결과: `2 files`, `40 tests` 모두 통과
- `npm run typecheck`
  - 결과: 통과

daemon 반영:
- 재시작 스킬 스크립트 사용
- 명령: `rebuild_restart_daemon.sh --repo /home/super/yonsei/mud/mudcode --skip-build`
- 상태 확인: daemon running (`port 18470`)

실행 중 daemon 환경변수 점검:
- `AGENT_DISCORD_CAPTURE_CODEX_FINAL_ONLY=1`
- `AGENT_DISCORD_CAPTURE_POLL_MS=1000`
- `HOOK_SERVER_PORT=18470`

주의:
- 재시작 시 env 주입이 빠지면 final-only가 꺼질 수 있으므로, restart 경로에서 동일 env를 유지해야 함

## 6) Git 처리 내역

진행 내역:
- 초기 커밋 후 push 시 remote fast-forward 불가로 거절
- `git pull --rebase --autostash origin main` 수행 후 재푸시 성공

최종 반영:
- `41c9c00` (세션 유지 restart 기본화 + 필터 강화)
- `4c2275f` (final-only flush 타이밍/채널 고정 보정)
- 두 커밋 모두 `origin/main` 반영 완료

현재 워크트리 상태:
- `bun.lock` 변경 1건은 의도적으로 커밋 제외 상태 유지

## 7) 왜 Discord에 중간 결과가 줄줄이 올라왔는지 요약

직접 원인 요약:
- progress/status/noise 라인 필터가 모든 변형을 커버하지 못한 구간이 있었고,
- final-only에서도 flush 타이밍이 빨라 완료 직후 잔여 delta가 별도 메시지로 분리 전송되었으며,
- 재시작 시 env가 누락되면 final-only 모드 자체가 꺼져 중간 출력이 다시 보일 수 있었다.

현재 상태 요약:
- 위 3가지 축(필터/flush/env)을 모두 보정했고, 테스트 및 실제 daemon 재시작 반영까지 완료했다.
