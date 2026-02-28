# OpenClaw vs Mudcode 중간 출력 처리 차이점

분석 기준 커밋:
- OpenClaw: `139271ad5a66214c3ebb794c50e99e4a181b541c`
- Mudcode: `b7a5c855f8c16f4f9b7c63c5e8404160a9a08c48`

## 차이점만 요약

| 항목 | OpenClaw | Mudcode |
|---|---|---|
| 스트리밍 제어 단위 | 에이전트 기본값 + 채널 오버라이드 + 옵션 + 계정/프로바이더 제한까지 합성해서 `blockStreaming` 여부/경계를 결정함. (`src/auto-reply/reply/get-reply-directives.ts:360-374`) | `AGENT_DISCORD_CAPTURE_CODEX_FINAL_ONLY` 기반의 전역 성격 토글 + `codex` 타입 중심 분기. (`src/bridge/capture-poller.ts:132-139`, `src/bridge/capture-poller.ts:298-304`) |
| 부분 응답 파이프라인 구조 | 별도 block pipeline에서 dedup/coalesce/idle flush/timeout/순서 보장 처리 후 전송. (`src/auto-reply/reply/block-reply-pipeline.ts:72-220`) | capture poller 내부 버퍼 + quiet/pending/working marker 휴리스틱으로 flush 시점 결정. (`src/bridge/capture-poller.ts:437-445`, `src/bridge/capture-poller.ts:825-879`) |
| 청크 정책 세밀도 | provider별 `textChunkLimit`, paragraph/newline chunk mode, 계정 단위 coalesce 설정까지 반영. (`src/auto-reply/reply/block-streaming.ts:87-188`) | 동일한 provider/account 단위 chunk/coalesce 정책 계층이 아니라, 메시지 전송 직전 분할(Discord/Slack 제한 대응) 중심. (`src/capture/parser.ts:72-154`) |
| 부분/최종 분리 계약 | gateway에서 `delta`/`final` lifecycle을 분리 송신하고 heartbeat/silent token 제거를 수행함. (`src/gateway/server-chat.ts:280-500`) | poller 쪽에서 완료 추정 후 버퍼를 최종으로 내보내는 구조(완료 신호 계약보다 로컬 추정 비중이 큼). (`src/bridge/capture-poller.ts:476-515`, `src/bridge/capture-poller.ts:825-879`) |
| 툴 출력 노출 제어 | `verbose`가 `off`이면 일반 채널로 tool 스트림 전달을 차단하고, 별도 수신자에만 전달 가능. (`src/gateway/server-chat.ts:406-455`) | 동일 경로 기준의 `tool verbose` 단계 게이트보다, 출력 필터/버퍼 중심으로 제어됨. (`src/bridge/capture-poller.ts:343-386`, `src/bridge/capture-poller.ts:1230-1284`) |
| UI 조립 방식 | UI에서 delta를 누적 조립하고 `final` 이벤트로 종료 처리하는 전용 assembler/state 흐름을 사용. (`src/tui/tui-event-handlers.ts:149-298`, `src/tui/tui-stream-assembler.ts:1-118`) | Discord/Slack 브리지로 이미 가공된 텍스트를 전송하는 방식이 중심이며, 외부 채널에서 delta/final 상태기계가 핵심 계약은 아님. (`src/bridge/capture-poller.ts`, `src/bridge/hook-server.ts:386-456`) |

## Mudcode에서 중간 출력이 남을 수 있는 차이 지점

- `AGENT_DISCORD_CAPTURE_CODEX_FINAL_ONLY`를 false로 두면 codex final-only 버퍼링이 비활성화되어 델타가 직접 전송될 수 있음. (`src/bridge/capture-poller.ts:132-139`, `src/bridge/capture-poller.ts:298-304`)
- final-only 버퍼링 자체가 `agentType === "codex"` 분기 중심이라, non-codex 경로는 즉시 전달될 수 있음. (`src/bridge/capture-poller.ts:298-304`, `src/bridge/capture-poller.ts:476-515`)
- prompt-echo 억제 실패시 fallback 경로가 `deliverDelta`를 호출해 중간 텍스트가 보일 수 있음. (`src/bridge/capture-poller.ts:639-704`)
- `esc to interrupt` working marker 부재 상황에서는 quiet/pending 기반 완료 추정이 빨라져 버퍼 조기 flush 가능성이 있음. (`src/bridge/capture-poller.ts:437-445`, `src/bridge/capture-poller.ts:825-879`)
