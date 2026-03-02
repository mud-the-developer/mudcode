# Codex Supervisor/Worker 오케스트레이션 실행 계획 (POC)

## 목표

- 사용자와 대화하는 상위 `Supervisor Codex` 1개를 기준으로 시스템 전체를 통제한다.
- 하위 `Worker` 인스턴스들은 병렬 작업 전용으로 사용하고, 최종 요약은 Supervisor 경로로만 노출한다.
- 이벤트 계약(`start/progress/final/error`)을 유지하면서 가시성 게이트를 시스템 계층에서 강제한다.

## 현재 상태 (시작점)

- 이벤트-계약형 파이프라인(v2)은 이미 적용됨.
- long-task 보고 스타일은 프롬프트 힌트 자동 주입까지 구현됨.
- 하지만 오케스트레이션은 아직 “모델 자율” 의존이 크고, 런타임 정책 강제는 제한적임.

## 단계별 실행 계획

### P0 - 제어면 추가 (POC 1단계)

- [x] `ProjectState`에 오케스트레이터 상태 모델 추가
  - `enabled`
  - `supervisorInstanceId`
  - `workerInstanceIds`
  - `workerFinalVisibility`
- [x] 상태 정규화(`normalizeProjectState`)에 orchestrator 유효성 정리 추가
- [x] Discord 런타임 명령 추가
  - `/orchestrator status`
  - `/orchestrator enable [supervisor] [hidden|thread|channel]`
  - `/orchestrator disable`
- [x] `hook-server` worker terminal 출력 억제 게이트 추가 (visibility=`hidden`)

### P1 - 실행면 강화 (POC 2단계)

- [x] Supervisor runtime 발주 명령 추가
  - `/orchestrator run <workerInstanceId> <task>`
  - idle worker는 즉시 발주, busy worker는 내부 queue로 전환
- [x] Supervisor가 worker 작업을 발주/회수하는 내부 작업 큐 추가
  - worker pending 시 queue 적재 후 백그라운드 drain
  - `/orchestrator status`에 worker별 queue depth/oldest age 노출
- [x] worker 실패/타임아웃 정책(재시도, 취소, escalate) 추가 (1차)
  - dispatch 실패 시 backoff 재시도 (`max retries` 초과 시 실패 보고)
  - queue wait timeout 초과 시 task drop + supervisor 채널 보고
- [x] worker 출력을 supervisor 전용 progress thread로 집약하는 1차 모드(`thread`) 구현
  - `session.progress/session.final/session.idle` 텍스트를 thread 경로로 강제
  - [x] thread 모드 worker 파일 첨부 relay 보강

### P2 - 결과면 강제 (POC 3단계)

- [x] Supervisor 최종 응답 포맷 검사기(Need your check / Changes / Verification) 추가
- [x] 미준수 시 자동 재요청 루프(최대 횟수 제한) 추가
- [x] `/doctor`에 orchestrator 정책 점검 항목 추가

### 운영 기본값(현재)

- auto-enable: `AGENT_DISCORD_ORCHESTRATOR_AUTO_ENABLE=1`
- auto-visibility: `AGENT_DISCORD_ORCHESTRATOR_AUTO_VISIBILITY=hidden`
- auto-dispatch: `AGENT_DISCORD_ORCHESTRATOR_AUTO_DISPATCH_MODE=auto`

### P3 - OpenClaw 스타일 정합성 고도화

- [x] directive 수준의 block-streaming 정책 계층(프로젝트/채널/인스턴스/agentType) 도입
- [x] 별도 block pipeline(dedup/coalesce/idle flush/timeout) 분리
- [x] worker 별 QoS(우선순위/동시성 제한) 추가
- [x] auto-dispatch fanout worker 수 제어 추가
- [x] strict event-only 모드에서 capture fallback 차단 옵션 추가

### P4 - 남은 정합성(후속)

- [x] 동적 worker spawn/teardown (에페메럴 워커)
  - 런타임 명령: `/orchestrator spawn [count]`, `/orchestrator remove <workerInstanceId>`
  - supervisor 전용 권한 체크 + worker queue/pending 정리 + 상태 동기화 반영
- [x] supervisor가 worker 작업 분할 계획을 구조적으로 생성/회수하는 planner 단계
  - auto fanout 시 bullet/템플릿 기반 task plan을 worker별로 분할 전송
  - planner payload에 `task scope + execution constraints + original request`를 계약형으로 포함
  - auto fanout 결과 보고에 worker별 `task`를 함께 노출

## 운영 체크포인트

1. `/orchestrator enable codex hidden` 실행
2. `/orchestrator status`로 supervisor/worker 배치 확인
3. worker 인스턴스에서 `session.final` 발생 시 채널 직접 출력이 억제되는지 확인
4. supervisor 인스턴스는 기존처럼 최종 출력이 정상 전달되는지 확인

## 롤백 가이드

- 긴급 비활성: `/orchestrator disable`
- 출력 억제 해제: `/orchestrator enable <supervisor> channel`
- 코드 롤백이 필요하면 최신 태그/커밋 기준으로 `message-router`, `hook-server`, `types/state` 변경분 우선 되돌림
