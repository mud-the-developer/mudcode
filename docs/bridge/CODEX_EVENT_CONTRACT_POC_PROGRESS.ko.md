# Codex 이벤트-계약형 POC 진행 로그

## 목표

- Codex 경로에 대해 `start / final / error` 이벤트를 훅 서버로 전송하는 1단계 POC를 구현한다.
- 기존 tmux capture 기반 경로를 즉시 제거하지 않고, 안정성 확인 전까지는 호환 모드로 유지한다.

## 범위 (1단계)

- 이벤트 송신 유틸 추가 (로컬 훅 서버 HTTP POST)
- 훅 서버에 범용 에이전트 이벤트 엔드포인트 추가
- Codex 경로에서 다음 이벤트 송신 연결
  - `session.start`
  - `session.final`
  - `session.error`
- 기본값은 기존 동작 유지(옵트인 플래그로 활성화)

## 체크포인트

### CP1 - 설계/분석 완료

- 현재 Codex는 `tmux capture fallback` 경로이며 native hook이 없다.
- 기존 `/opencode-event` 경로는 payload가 일반화되어 있어 Codex 이벤트로도 확장 가능하다.
- 1단계에서는 외부 Codex 플러그인까지 가지 않고, Mudcode 내부에서 훅 전송 계약을 먼저 고정한다.

### CP2 - 구현 진행 중

- ✅ 공통 이벤트 엔드포인트 추가: `POST /agent-event`
  - 기존 `POST /opencode-event` 유지 (하위호환)
  - 공통 처리 이벤트: `session.start`, `session.final`, `session.idle`, `session.error`
- ✅ Codex POC 이벤트 송신 클라이언트 추가: `src/bridge/events/agent-event-hook.ts`
  - 전송 대상: `http://127.0.0.1:${HOOK_SERVER_PORT}/agent-event`
  - 기본 비활성(옵트인): `AGENT_DISCORD_CODEX_EVENT_POC=1`
- ✅ Codex start/error 훅 송신 연결 (`message-router`)
  - submit 성공 시 `session.start`
  - submit 예외 시 `session.error`
- ✅ Codex final 훅 송신 연결 (`capture-poller`)
  - final-only flush 시 `session.final` 전송
  - 훅 전송 성공 시 채널 직접 전송 생략(중복 방지)
  - 훅 전송 실패 시 기존 채널 전송으로 fallback
- ✅ 배선 완료 (`index.ts`)
  - `LocalAgentEventHookClient` 생성 후 `message-router`, `capture-poller`에 주입

### CP3 - 테스트/재시작 검증

- ✅ 타입체크 통과: `npm run typecheck`
- ✅ 타겟 테스트 통과:
  - `tests/bridge/runtime/hook-server.test.ts`
  - `tests/bridge/runtime/message-router.test.ts`
  - `tests/bridge/runtime/capture-poller.test.ts`
- ✅ daemon 재시작 완료:
  - `bun run build`
  - `bun dist/bin/mudcode.js daemon stop`
  - `bun dist/bin/mudcode.js daemon start`
  - `bun dist/bin/mudcode.js daemon status`
- ✅ 로그 모니터링 + 실이벤트 검증(2026-02-28)
  - `tail -F ~/.mudcode/daemon.log` 캡처 중 `POST /agent-event` 3종 전송
  - `session.start` -> HTTP 200
  - `session.final` -> HTTP 200
  - `session.error` -> HTTP 200
  - daemon 로그 확인:
    - `route=agent-event event=session.start`
    - `route=agent-event event=session.final`
    - `route=agent-event event=session.error`

### CP4 - V2 정합성 기반(진행 중)

- ✅ 이벤트 계약에 `turnId` 추가 (`agent-event` payload)
- ✅ `message-router`의 `session.start/error` 전송에 `turnId(messageId)` 포함
- ✅ `capture-poller`의 `session.final` 전송에 마지막 pending `turnId` 전달
- ✅ `pending-message-tracker`에 `messageId` 직접 종료 API 추가
  - `markCompletedByMessageId`
  - `markErrorByMessageId`
- ✅ `hook-server`에서 `turnId` 존재 시 head/tail 추정 대신 해당 messageId를 직접 완료/실패 처리
- ✅ 회귀 검증
  - `npm run typecheck`
  - `vitest` 브리지 핵심 테스트 113건 통과
  - daemon 재시작 후 `turnId` 포함 `session.start/final/error` HTTP 200 및 로그 확인

### CP5 - V2 멱등/비차단(진행 중)

- ✅ 이벤트 계약에 `eventId` 추가
- ✅ `hook-server` dedupe 처리 추가
  - 동일 `(project/agent/instance/eventId)` 재수신 시 중복 처리 생략
  - dedupe retention/max 엔트리 환경변수 추가
    - `AGENT_DISCORD_EVENT_DEDUPE_RETENTION_MS`
    - `AGENT_DISCORD_EVENT_DEDUPE_MAX`
- ✅ `LocalAgentEventHookClient` 비차단 outbox/retry 추가 (`start/error`)
  - `start/error`는 enqueue 후 즉시 반환
  - 백오프 재시도 파라미터:
    - `AGENT_DISCORD_EVENT_HOOK_RETRY_MAX`
    - `AGENT_DISCORD_EVENT_HOOK_RETRY_BASE_MS`
    - `AGENT_DISCORD_EVENT_HOOK_RETRY_MAX_MS`
- ✅ `message-router`에서 start/error 훅 전송을 비동기 fire-and-forget으로 전환
- ✅ 실로그 검증: 동일 `eventId` `session.final` 2회 전송 시 2번째 dedupe skip 확인

### CP6 - V2 lifecycle 상태기계/관측성(진행 중)

- ✅ `hook-server` lifecycle 상태기계 추가
  - stage: `started`, `progress`, `final`, `error`, `cancelled`
  - `turnId`, `eventId`, `updatedAt` 추적
- ✅ `session.progress` 이벤트 수신 지원 (상태만 갱신)
- ✅ `session.cancelled` 이벤트 수신 지원
  - 해당 `turnId` pending 직접 종료 후 안내 메시지 전송
- ✅ `/runtime-status`에 lifecycle 스냅샷 포함
  - `eventLifecycleStage`
  - `eventLifecycleTurnId`
  - `eventLifecycleEventId`
  - `eventLifecycleUpdatedAt`
  - `eventLifecycleAgeMs`
  - `eventLifecycleStale`
- ✅ 테스트 추가/통과
  - runtime-status lifecycle 노출
  - session.cancelled 처리
  - 전체 브리지 테스트 115건 통과

### CP7 - V2 훅 클라이언트 안정화(진행 중)

- ✅ `LocalAgentEventHookClient` 단위 테스트 추가
  - 비활성 모드 무동작
  - start 이벤트 비동기 enqueue + eventId 생성
  - start 이벤트 재시도(backoff) 동작
  - final 이벤트 즉시 전송 + eventId 포함
- ✅ 브리지 통합 테스트 + 훅 클라이언트 테스트 동시 통과
  - 총 119 tests passed

### CP8 - V2 순서보장/우회복구(진행 중)

- ✅ 이벤트 계약에 `seq` 추가 (`agent-event` payload)
- ✅ `LocalAgentEventHookClient` turn 단위 `seq` 자동 증가
  - 동일 `turnId` 반복 전송 시 `seq=1,2,3...` 부여
  - `eventId` 생성 시 `seq` 포함
- ✅ `hook-server` 순서 가드 추가
  - 동일 `(project/agent/instance/turnId)`에서 더 낮거나 같은 `seq`는 skip
  - lifecycle 스냅샷에 `eventLifecycleSeq` 노출
  - 환경변수:
    - `AGENT_DISCORD_EVENT_SEQ_RETENTION_MS`
    - `AGENT_DISCORD_EVENT_SEQ_MAX`
- ✅ `capture-poller` stale 기반 fallback 캡처 추가
  - `eventHook=true` 인스턴스도 lifecycle stale 시 임시 capture 활성화
  - lifecycle 회복 시 fallback 자동 해제
- ✅ 테스트 추가/통과
  - `agent-event-hook`: turn별 `seq` 증가 검증
  - `hook-server`: 역순 `seq` 이벤트 skip 검증
  - `capture-poller`: stale 시 eventHook 인스턴스 fallback 캡처 검증
  - 총 122 tests passed

### CP9 - V2 진행 하트비트/운영 점검(진행 중)

- ✅ `agent-event-hook`에 `session.progress` 송신 API 추가
  - `emitCodexProgress(...)`
- ✅ `capture-poller`에서 codex 진행 하트비트 전송 추가
  - 델타 감지 시 `session.progress` 전송 (throttle)
  - working marker(`Esc to interrupt`) 유지 중에도 주기적 progress heartbeat 전송
  - 하트비트 간격 환경변수:
    - `AGENT_DISCORD_CAPTURE_CODEX_PROGRESS_HOOK_MIN_INTERVAL_MS` (기본 5000ms)
- ✅ `hook-server` 테스트 보강
  - `session.progress` 수신 시 무출력 + lifecycle(`progress`, `turnId`, `eventId`, `seq`) 갱신 검증
- ✅ 운영 스모크체크 스크립트 추가
  - `scripts/check/check-codex-event-contract.mjs`
  - `npm run event-contract:check`
  - 검증 내용:
    - `/runtime-status`로 대상 codex 인스턴스 탐색
    - `/agent-event` `start -> progress -> final` 전송
    - lifecycle 최종 상태(`final`, `turnId`, `seq=3`) 확인
    - (옵션) 역순 seq 이벤트 전송 후 sequence guard 유지 확인

### CP10 - 리뷰 기반 안정화(진행 중)

- ✅ progress hook 전송 비차단화
  - `capture-poller` 루프에서 progress 훅 전송을 `await`하지 않도록 변경
  - in-flight 가드(`progressHookInFlightByInstance`) 추가
  - 실패 시 heartbeat 타임스탬프를 갱신하지 않도록 조정
- ✅ eventHook disabled 이벤트 상태오염 방지
  - `hook-server`에서 disabled ignore를 dedupe/seq 처리보다 먼저 수행
  - ignored 이벤트가 dedupe/seq 상태를 오염시키지 않음
- ✅ event-hook fallback 게이트 보강
  - lifecycle 체크를 `missing-or-stale` 기준으로 확장
  - 단, pending 활동이 있을 때만 fallback capture 활성화
- ✅ 테스트 보강
  - `hook-server`: ignored 이벤트가 dedupe/seq를 오염시키지 않는지 검증
  - `capture-poller`: progress hook in-flight 중에도 델타 전송이 막히지 않는지 검증
  - `capture-poller`: pending 없는 eventHook 인스턴스는 stale fallback 미활성 검증
