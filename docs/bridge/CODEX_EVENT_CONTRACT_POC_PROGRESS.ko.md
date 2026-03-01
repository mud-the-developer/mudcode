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

### CP11 - V2 progress 텍스트 계약 확장(진행 중)

- ✅ `capture-poller`에서 `session.progress` 훅 전송 시 delta 텍스트 포함
  - 기존: lifecycle heartbeat 중심(`text` 없음)
  - 변경: `emitCodexProgress(..., text)`로 전달
- ✅ `hook-server`에 progress 출력 게이트 추가
  - 환경변수: `AGENT_DISCORD_EVENT_PROGRESS_FORWARD`
    - `off`(기본): 기존과 동일하게 progress 무출력
    - `thread`: Discord `sendToProgressThread`로 전달
    - `channel`: 일반 채널로 전달
  - boolean 호환값: `1/true/on -> thread`, `0/false/off -> off`
- ✅ 테스트 보강
  - `capture-poller`: progress 훅 payload에 `text` 포함 검증
  - `hook-server`: 기본값(off) 무출력 유지 검증
  - `hook-server`: `thread` 모드에서 progress 텍스트 전달 검증

### CP12 - V2 progress block-streaming 파이프라인(진행 중)

- ✅ `hook-server` progress 전달에 block coalesce 추가
  - 짧은 윈도우 동안(`AGENT_DISCORD_EVENT_PROGRESS_BLOCK_WINDOW_MS`) progress 텍스트를 합쳐 1회 전달
  - 버퍼 최대 길이(`AGENT_DISCORD_EVENT_PROGRESS_BLOCK_MAX_CHARS`) 도달 시 즉시 flush
  - 활성/비활성: `AGENT_DISCORD_EVENT_PROGRESS_BLOCK_STREAMING` (기본 `on`)
- ✅ 터미널 이벤트 연동
  - `session.final / session.error / session.cancelled / session.start`에서 해당 turn progress 버퍼 정리
  - final 도착 직전에 남아 있던 중간 버퍼가 뒤늦게 출력되지 않도록 차단
- ✅ 테스트 보강
  - progress 2회 연속 수신 시 1회 coalesced flush 검증
  - final 선도착 시 buffered progress drop 검증

### CP13 - V2 codex event-only 출력 게이트(진행 중)

- ✅ `capture-poller`에 Codex event-only 모드 추가
  - 환경변수: `AGENT_DISCORD_CODEX_EVENT_ONLY`
  - 조건: `codex` + `eventHookClient.enabled`
  - 동작: tmux 캡처는 유지하되, direct channel progress/final 출력 경로는 차단하고 훅 이벤트 경로만 사용
- ✅ strict event-only fallback 차단
  - final 훅 전송 실패 시 direct `sendToChannel` fallback 미사용(재시도 대기)
- ✅ final-only 비버퍼 경로 lifecycle 보강
  - `codexFinalOnly=false`에서도 pending 종료 시 `session.final(text='')`를 송신해 lifecycle 종료 신호를 보장
- ✅ 테스트 보강
  - event-only에서 direct progress 미전송 + progress hook 송신 검증
  - event-only + non-final-only에서 `session.final(text='')` 송신 검증
  - event-only에서 final hook 실패 시 direct fallback 미발생 검증

### CP14 - tmux transport(local/ssh) 기반 정리(진행 중)

- ✅ `tmux` 실행 transport 설정 추가
  - `config`/env 확장:
    - `tmux.transport`: `local | ssh`
    - `tmux.sshTarget`, `tmux.sshIdentity`, `tmux.sshPort`
    - env: `TMUX_TRANSPORT`, `TMUX_SSH_TARGET`, `TMUX_SSH_IDENTITY`, `TMUX_SSH_PORT`
- ✅ SSH executor 추가
  - `src/infra/ssh.ts`
  - 기존 tmux 명령 문자열을 SSH로 래핑해 원격 tmux에서 실행 가능
- ✅ `TmuxManager` 생성 경로 통합
  - `src/tmux/factory.ts` 추가 (`createTmuxManager`)
  - daemon/cli/app/index에서 `new TmuxManager(...)` 직접 생성 제거, 팩토리 경유로 통일
- ✅ CLI 연결 경로 SSH 대응
  - `attachToTmux`가 transport-aware(`local`/`ssh`)로 동작
  - `ensureTmuxInstalled`가 SSH 모드에서는 `tmux` 대신 `ssh`만 검사
  - `status` 출력에 tmux transport/ssh target 정보 노출
- ✅ 설정 검증 강화
  - `TMUX_TRANSPORT` 값 검증
  - `TMUX_SSH_TARGET`/`TMUX_SSH_PORT` 형식 검증
  - `TMUX_TRANSPORT=ssh`일 때 target 누락 에러 처리
- ✅ 회귀 검증
  - `npm run typecheck`
  - 타겟 테스트 통과:
    - `tests/config/index.test.ts`
    - `tests/infra/ssh.test.ts`
    - `tests/tmux/factory.test.ts`
    - `tests/tmux/manager.test.ts`
    - `tests/cli/commands/health.test.ts`
    - `tests/daemon-command.test.ts`
    - `tests/mudcode-cli.test.ts`

### CP15 - 이벤트 파이프라인 final 복원력 강화(진행 중)

- ✅ `hook-server`에 turn 단위 progress transcript 누적 추가
  - `session.progress` 텍스트를 turn 기준으로 병합/보관
  - 보관 상한 env:
    - `AGENT_DISCORD_EVENT_PROGRESS_TRANSCRIPT_MAX_CHARS`
- ✅ `session.final/session.idle` 텍스트 공백 시 transcript fallback 전달 추가
  - event-only/non-final-only에서 final 본문이 비어도 결과 유실 방지
  - 기본 활성, 비활성 env:
    - `AGENT_DISCORD_EVENT_FINAL_FROM_PROGRESS_ON_EMPTY=0`
  - `progress forward=channel`인 경우 채널 중복을 피하기 위해 fallback 미사용
- ✅ terminal 이벤트(start/error/cancelled/final/idle)에서 transcript 정리
- ✅ 테스트 보강
  - `session.final(text='')` 시 누적 progress transcript가 채널로 전달되는지 검증

### CP16 - 이벤트 계약형 progress override(진행 중)

- ✅ `agent-event` payload에 progress 지시자 확장
  - `progressMode`: `off | thread | channel`
  - `progressBlockStreaming`: boolean
  - `progressBlockWindowMs`: number
  - `progressBlockMaxChars`: number
- ✅ `hook-server`가 이벤트 단위 override를 env 기본값보다 우선 적용
  - OpenClaw의 directive-level block-streaming에 맞춘 계약형 제어 기반 추가
- ✅ 테스트 보강
  - 글로벌 `AGENT_DISCORD_EVENT_PROGRESS_FORWARD=off` 상태에서도
    이벤트 payload override(`progressMode=thread`, `progressBlockStreaming=false`)로
    즉시 progress thread 전달되는지 검증

### CP17 - 이벤트 계약형 V2 가드/전달 강화(진행 중)

- ✅ `capture-poller -> event-hook` progress 계약 필드 전달 추가
  - `emitCodexProgress(...)`에 아래 필드 전달:
    - `progressMode`
    - `progressBlockStreaming`
    - `progressBlockWindowMs`
    - `progressBlockMaxChars`
  - env 우선순위:
    - codex 전용: `AGENT_DISCORD_CODEX_EVENT_PROGRESS_*`
    - fallback: `AGENT_DISCORD_EVENT_PROGRESS_*`
- ✅ `hook-server` lifecycle strict 모드 추가
  - env: `AGENT_DISCORD_EVENT_LIFECYCLE_STRICT_MODE`
    - `off`(기본): 기존 동작
    - `warn`: start 없는 terminal/progress 이벤트 경고 로그 후 수용
    - `reject`: start 없는 terminal/progress 이벤트 무시
  - started turn 보관 env:
    - `AGENT_DISCORD_EVENT_STARTED_TURN_RETENTION_MS`
- ✅ strict 모드 테스트 보강
  - `reject` 모드에서 `session.start` 없는 `session.final` 무시
  - 동일 turn에 `session.start` 후 `session.final`은 정상 수용

### CP18 - 계약 누락 관측성/doctor 점검 강화(진행 중)

- ✅ `hook-server /runtime-status`에 strict 거부 이벤트 카운터 추가
  - `lifecycleRejectedEventCount`
  - `lifecycleRejectedEventTypes`
  - `lifecycleRejectedLastAt`
- ✅ `health` 명령이 lifecycle reject 카운터를 진단에 반영
  - 인스턴스별 `contract:<project>/<instance>` 경고 추가
- ✅ `doctor` 명령이 이벤트-계약 점검 규칙 추가
  - `AGENT_DISCORD_CODEX_EVENT_ONLY=1` + `AGENT_DISCORD_EVENT_LIFECYCLE_STRICT_MODE=off` 경고
  - `/runtime-status`에서 lifecycle reject가 감지되면 경고(또는 strict=reject일 때 fail)
  - doctor summary에 runtime reject 집계 노출

### CP19 - turn 단위 progress 모드 계약 정합성 강화(진행 중)

- ✅ `hook-server`가 turn별 progress 전달 모드(`off/thread/channel`)를 추적
  - `session.progress` 수신 시 실제 적용된 mode를 turn 키에 기록
  - cleanup/prune 경로에 mode 상태 포함
- ✅ `session.final/session.idle` 빈 텍스트 fallback 판단을 turn 실측 mode 기준으로 전환
  - 기존: 글로벌 `AGENT_DISCORD_EVENT_PROGRESS_FORWARD`만 참고
  - 변경: 해당 turn의 마지막 progress mode를 우선 사용
  - 효과:
    - turn override가 `channel`이면 transcript fallback 중복 전송 방지
    - 글로벌이 `channel`이어도 turn override가 `thread/off`이면 fallback 복원 가능
- ✅ 테스트 보강
  - per-turn `progressMode=channel`일 때 `final(text='')` transcript 중복 미발생 검증
  - 글로벌 `channel` + per-turn `progressMode=thread`에서도 transcript fallback 동작 검증

### CP20 - progress 모드 런타임 가시성 강화(진행 중)

- ✅ `hook-server /runtime-status`에 인스턴스별 progress mode 스냅샷 노출 추가
  - `eventProgressMode`
  - `eventProgressModeTurnId`
  - `eventProgressModeUpdatedAt`
  - `eventProgressModeAgeMs`
- ✅ `health`가 progress mode runtime 필드를 파싱/표시
  - runtime 설명 문자열에 `progressMode=<mode>(turnId)` suffix 반영
  - JSON 출력의 `instances[].runtime`에도 mode 필드 포함
- ✅ `doctor` runtime summary 확장
  - `/runtime-status` 기반 progress mode 분포 집계:
    - `off/thread/channel/unknown`
  - 사람 출력/JSON summary에 집계값 노출
- ✅ 테스트 보강
  - `hook-server`: runtime-status에 latest progress mode 스냅샷 노출 검증
  - `health`: runtime progress mode 필드 파싱/노출 검증

### CP21 - event-only 계약 경고 룰 강화(진행 중)

- ✅ `health`에 event-only 운영용 계약 경고 룰 추가
  - `AGENT_DISCORD_CODEX_EVENT_ONLY=1` 상태에서 codex runtime `progressMode=channel` 감지 시 경고
  - 기대 모드(`AGENT_DISCORD_CODEX_EVENT_PROGRESS_MODE` 또는 fallback `AGENT_DISCORD_EVENT_PROGRESS_FORWARD`)와
    runtime 모드 불일치 시 경고
  - pending 중 `eventProgressModeAgeMs`가 임계(`AGENT_DISCORD_EVENT_PROGRESS_MODE_STALE_WARN_MS`, 기본 90s)를 넘으면 경고
- ✅ `doctor`에 event-only+runtime mode 불일치 규칙 추가
  - event-only 활성 + runtime codex `progressMode=channel` 인스턴스 존재 시
    `event-contract-progress-channel` 경고
  - summary에 `runtimeCodexProgressModeChannel` 집계 노출
- ✅ 테스트 보강
  - `health`: event-only + channel 모드 경고 검증
  - `health`: pending 중 progress mode stale 경고 검증
  - `doctor`: event-only + codex runtime channel 모드 경고(`event-contract-progress-channel`) 검증

### CP22 - event-contract 체크 스크립트 계약 검증 확장(진행 중)

- ✅ `scripts/check/check-codex-event-contract.mjs` 확장
  - progress mode 검증 옵션 추가:
    - `--progress-mode <off|thread|channel>`: `session.progress` payload에 mode 주입
    - `--expect-progress-mode <auto|skip|off|thread|channel>`
    - `--no-progress-mode-check`
  - freshness 검증 옵션 추가:
    - `--max-progress-mode-age-ms <n>`
  - 기본 동작:
    - `expect-progress-mode=auto`
    - `AGENT_DISCORD_EVENT_PROGRESS_FORWARD` 또는 주입 mode를 기준으로 기대값 자동 결정
- ✅ 체크 항목 확장
  - 기존 lifecycle(`stage=final`, `seq=3`) + seq-guard 검증 유지
  - runtime `eventProgressMode` 일치 여부 검증 추가
  - runtime `eventProgressModeAgeMs` 임계 이내인지 검증 추가
- ✅ 실검증
  - 기본 모드(`off`) 체크 통과
  - `--progress-mode thread` 체크 통과

### CP23 - Discord `/doctor` 요약 가독성 개선(진행 중)

- ✅ `message-router`의 `/doctor` 요약 포맷 확장
  - 상단에 계약/모드 핵심 요약 라인 추가:
    - `contract: <n issue(s)|clean>`
    - `progress modes: off/thread/channel/unknown`
    - `codex channel-mode: <count>`
  - 계약 관련 이슈(`event-contract*`)를 `contract highlights` 섹션으로 별도 노출
- ✅ 테스트 보강
  - `/doctor` 요약에 progress mode 분포 및 contract highlight가 포함되는지 검증

### CP24 - event-only progress 모드 강제 게이트(진행 중)

- ✅ `hook-server`에 codex event-only progress 모드 강제 로직 추가
  - 조건: `AGENT_DISCORD_CODEX_EVENT_ONLY=1` + `agentType=codex`
  - 정책:
    - 요청 mode가 `channel`이면 `thread`로 강제 다운그레이드
    - Discord progress thread를 사용할 수 없는 환경이면 `off`로 강제(채널 중간출력 차단)
  - 적용 시 runtime에 기록되는 `eventProgressMode`도 강제된 mode 기준으로 반영
- ✅ 운영 로그 보강
  - 강제 변환이 발생하면 `event-only progress mode adjusted <from> -> <to>` 로그 남김
- ✅ 테스트 보강
  - event-only + `progressMode=channel` 요청 시 thread로 강제 전달 검증
  - event-only + thread 미지원 환경에서 progress 전달 차단(`off`) 검증

### CP25 - event-contract 스모크 진단 힌트 보강(진행 중)

- ✅ `scripts/check/check-codex-event-contract.mjs` 실패 메시지 개선
  - `expected=thread, observed=channel` + `AGENT_DISCORD_CODEX_EVENT_ONLY=1` 조합에서
    daemon 재시작 필요 힌트를 함께 출력
  - 목적: 셸 env만 바꾸고 daemon을 재기동하지 않았을 때 발생하는 오탐/혼동을 즉시 식별

### CP26 - 긴작업 보고 스타일 힌트 자동 주입(진행 중)

- ✅ `message-router`에 codex long-task report 힌트 주입 추가
  - 환경변수: `AGENT_DISCORD_CODEX_AUTO_LONGTASK_REPORT_MODE`
    - `continue`(기본): `continue/계속/쭉/진행` 류 프롬프트에서만 주입
    - `auto`: continuation 또는 대형 컨텍스트 프롬프트에서 주입
    - `always`: 모든 codex 프롬프트에 주입
    - `off`: 비활성화
  - 힌트 내용:
    - 가능한 범위까지 자율 진행
    - 중간 확인 최소화(수동 결정/체크 필요 시에만 요청)
    - 최종 보고를 `Need your check / Changes / Verification` 3항목으로 제한
- ✅ 테스트 보강
  - continuation 프롬프트에서 힌트 주입 검증
  - `off` 모드에서 힌트 비주입 검증
