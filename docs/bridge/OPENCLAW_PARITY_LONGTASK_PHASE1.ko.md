# OpenClaw 정합성 장기작업 - Phase 1 완료 로그

## 목표

- `tmux` 기반 세션/전송 계층은 유지한다.
- 상위 제어(명령 UX, 출력 가시성 게이트, 정책 해석기)를 OpenClaw 스타일로 수렴한다.

## 이번 턴 적용 범위

- [x] 오케스트레이터 정책 해석기 공용 모듈 분리
  - `src/bridge/runtime/orchestrator-progress-policy.ts`
  - 역할 판정(`supervisor/worker/none`)
  - worker visibility 판정(`hidden/thread/channel`)
  - progress policy 합성(`default -> byAgentType -> byInstanceId -> byChannelId`)
- [x] `hook-server` 정책 해석기 호출 경로를 공용 모듈로 정리
- [x] `capture-poller` fallback 경로에 worker visibility 게이트 반영
  - hidden: worker 출력 차단
  - thread: worker 출력을 progress thread로 라우팅
- [x] event-hook stale fallback 안정화(휴리스틱 축소)
  - stale 즉시 fallback 대신 grace 구간 이후 활성화
  - env: `AGENT_DISCORD_EVENT_HOOK_CAPTURE_FALLBACK_STALE_GRACE_MS` (기본 10s)
  - 관련 회귀 테스트 추가
- [x] capture 휴리스틱 추가 축소 (event hook lifecycle 중심)
  - eventHook 캡처 경로에서 prompt-echo 과다 suppression 시 raw delta fallback 기본 차단
  - env: `AGENT_DISCORD_CAPTURE_PROMPT_ECHO_FALLBACK_EVENT_HOOK` (기본 off)
  - strict event-only에서 중간 텍스트 노출 리스크 완화
- [x] OpenClaw 스타일 `/subagents` alias 추가 (오케스트레이터 매핑)
  - `list`, `spawn`, `send`, `kill`, `kill all`
- [x] `/subagents list` 실행 메타 강화
  - worker index(` #1 -> instanceId`) 표기
  - worker runtime 세부 상태(활성/큐/stage) 확장
  - 최근 오케스트레이터 작업 상태/요약(task summary) 노출
  - queue head 요약(age + task excerpt) 노출
- [x] block-streaming 세밀도 확장 (capture->hook 경로)
  - capture-poller의 codex progress hook 송신에서도 orchestrator progress policy(`byChannel/byInstance/byAgentType`) 적용
  - mode/block(window/chars)/streaming 플래그를 hook payload에 일관 반영
- [x] 운영 점검 규칙 확장
  - `doctor`: event-only + prompt-echo raw fallback/eventHook stale grace 고위험 설정 경고
  - `health`: event-only fallback knob 경고(캡처 fallback on, raw-delta fallback on, stale grace 과다)
- [x] 회귀 테스트/문서 갱신

## 다음 Phase 권장 작업

- 현재 Phase 1 범위(요청 스코프) 완료.
- 후속은 운영 튜닝/고도화(예: 정책 프리셋 UX, runtime 명령으로 정책 live 변경) 중심으로 진행 권장.
