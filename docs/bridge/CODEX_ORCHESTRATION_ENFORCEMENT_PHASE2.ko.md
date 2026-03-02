# Codex Orchestration Enforcement Phase 2

작성일: 2026-03-02

## 목적

OpenClaw 스타일의 이벤트-계약형 오케스트레이션에 맞춰 다음 3가지를 보강했다.

1. 워커 위임 프롬프트의 계약 게이트(Delegation Contract Gate)
2. Supervisor 직접구현 방지 가드(Anti Direct-Implementation Guard)
3. Supervisor 최종 응답 증거 게이트(Final Evidence Gate)

또한 이번 턴에서는 요청된 sub-agent 병렬 실행을 먼저 시도했지만, 세션의 협업 스레드 한도(max 6)에 걸려 코드 내 병렬 분기 구조로 대체 진행했다.

## 변경 요약

### 1) Delegation Contract Gate

대상 파일: `src/bridge/runtime/message-router.ts`

- 오케스트레이터가 워커에게 작업을 던질 때, 프롬프트 계약 준수 여부를 검사한다.
- 이미 계약 블록(`mudcode orchestrator-plan` 또는 `mudcode delegation-contract`)이 있으면 통과한다.
- 모드는 환경변수로 제어한다.

환경변수:

- `AGENT_DISCORD_ORCHESTRATOR_DELEGATION_CONTRACT_MODE`
  - `off`: 검사/강제 비활성
  - `warn`(기본): 계약 미준수 시 동작은 유지하고 경고 로그만 출력
  - `enforce`: 계약 래퍼(`mudcode delegation-contract`)를 강제 주입

`enforce` 모드에서 워커 프롬프트는 다음 구조를 가진다.

- 계약 메타(project/supervisor/worker)
- `[worker-task] ... [/worker-task]`
- 최종 출력 계약(Need your check / Changes / Verification)

### 2) Supervisor Anti Direct-Implementation Guard

대상 파일: `src/bridge/runtime/message-router.ts`

- Codex 인스턴스가 orchestrator supervisor일 때, supervisor 본인 프롬프트에 가드 블록을 주입한다.
- 핵심 규칙:
  - 워커 위임 전에 supervisor가 직접 구현하지 않음
  - 워커 결과를 모아 통합
  - 최종 응답은 3-섹션 포맷 준수
- 워커로 fanout 되는 프롬프트에는 이 가드를 섞지 않도록 분리 처리했다.

환경변수:

- `AGENT_DISCORD_ORCHESTRATOR_SUPERVISOR_GUARD`
  - `1`/`true`(기본): 가드 적용
  - `0`/`false`: 비활성

### 3) Supervisor Final Evidence Gate

대상 파일: `src/bridge/runtime/capture-poller.ts`

기존 형식 검사(1/2/3 섹션 존재)에 더해 증거 필수 검사를 추가했다.

- `Changes` 증거:
  - 파일 경로 기반 델타가 있거나
  - 명시적 no-change(`none`, `no changes`, `변경 없음`)가 있어야 함
- `Verification` 증거:
  - 실행 명령 텍스트가 있고
  - 결과(pass/fail/success/error/skip 등)가 함께 있어야 함

미준수 시 supervisor final-format retry 프롬프트를 재요청한다.

환경변수:

- `AGENT_DISCORD_SUPERVISOR_FINAL_REQUIRE_EVIDENCE`
  - `1`/`true`(기본): 증거 게이트 활성
  - `0`/`false`: 형식만 검사

## 테스트 변경

대상 파일:

- `tests/bridge/runtime/message-router.test.ts`
- `tests/bridge/runtime/capture-poller.test.ts`

추가/보강된 테스트:

- supervisor guard 자동 주입
- delegation contract `enforce` 래핑
- final-format 헤더만 있고 증거가 없을 때 retry 유도
- 파일/명령+결과 증거가 있으면 정상 통과

## 실행 검증

실행 명령:

- `bun run test -- tests/bridge/runtime/message-router.test.ts`
- `bun run test -- tests/bridge/runtime/capture-poller.test.ts`
- `bun run typecheck`
- `bun run orchestrator:auto:check`
- `bun run event-contract:check`

결과:

- 모두 통과

## 운영 메모

- 기본 계약 모드는 `warn`이라 기존 동작을 최대한 유지한다.
- 점진 적용 권장 순서:
  1. `warn`으로 운영 관찰
  2. 워커 프롬프트 템플릿 정착
  3. `enforce` 전환
- sub-agent 병렬 작업은 현재 세션 스레드 한도(6) 관리가 선행되어야 안정적으로 자동 병렬화할 수 있다.
