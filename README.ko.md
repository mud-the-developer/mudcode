# Mudcode

AI 에이전트 CLI를 `tmux`에서 실행하고 Discord/Slack과 연결하는 브리지입니다.

English: [README.md](README.md)

## Mudcode가 하는 일

- 인스턴스별로 `tmux` 윈도우를 운영
- 에이전트 출력을 Discord/Slack으로 전달
- 채팅 입력을 올바른 pane으로 다시 라우팅
- 프로젝트/인스턴스 수명주기를 단일 CLI로 관리

지원 어댑터:

- Claude Code
- Gemini CLI
- OpenCode
- OpenAI Codex CLI

## 요구 사항

- Bun `>= 1.3`
- tmux `>= 3.0`
- Discord 봇 토큰(또는 Slack bot/app 토큰)
- 지원되는 에이전트 CLI 최소 1개 로컬 설치

## 설치

권장 (Bun 글로벌 설치):

```bash
bun add -g @mudramo/mudcode
```

설치 확인:

```bash
mudcode --version
```

## 최초 설정

1. 플랫폼 토큰 설정:

```bash
mudcode onboard
```

2. 프로젝트 디렉토리에서 인스턴스 생성:

```bash
cd ~/projects/my-app
mudcode new codex
```

3. 필요할 때 세션 연결:

```bash
mudcode attach my-app --instance codex
```

## 핵심 명령어

- `mudcode tui`: 인터랙티브 UI 실행
- `mudcode new [agent]`: 인스턴스 생성/재개
- `mudcode list`: 프로젝트/인스턴스 목록
- `mudcode status`: 설정 + 런타임 상태
- `mudcode health [--project <name>] [--json]`: 진단 실행 (옵션으로 단일 프로젝트 범위 지정)
- `mudcode daemon <start|stop|status|restart>`: 데몬 관리
- `mudcode doctor [--fix]`: 설정/환경/런타임 드리프트 점검 및 자동 수정
- `mudcode repair [mode] [--project <name>]`: 셀프힐 실행 (`default|doctor-only|restart-only|verify|deep`)
- `mudcode update [--git] [--explain]`: 최신 버전 업데이트 (git 자동 감지 지원, `--explain`은 실행 계획만 출력)
- `mudcode stop [project] --instance <id>`: 특정 인스턴스 중지
- `mudcode skill list [--all]`: `AGENTS.md`와 `.agents/skills` 기반 스킬 목록/상태 확인
- `mudcode skill install [name]`: 로컬/no-api 스킬을 Codex 스킬 디렉토리에 설치
- `mudcode config --show`: 현재 설정 출력
- `mudcode config --capture-final-buffer-max-chars <n>`: final-only 버퍼 예산 조정
- `mudcode uninstall`: mudcode 제거

## 프롬프트 정제기 (Shadow 모드)

강제 적용 전에 프롬프트 정제 효과를 안전하게 검증할 때 사용합니다.

1. Shadow 모드 활성화:

```bash
mudcode config --prompt-refiner-mode shadow
```

2. (선택) 로그 경로 지정:

```bash
mudcode config --prompt-refiner-log-path ~/.mudcode/prompt-refiner-shadow.jsonl
```

3. 요약 리포트 생성:

```bash
bun run prompt-refiner:report
```

4. GEPA용 train/val 데이터셋 생성:

```bash
bun run prompt-refiner:export-gepa
# 옵션 예시:
# bun run prompt-refiner:export-gepa -- --val-ratio 0.2 --all --dedupe-key baseline-candidate --split-key baseline
# JS fallback:
# bun run prompt-refiner:export-gepa:js -- --val-ratio 0.2 --all --dedupe-key baseline-candidate --split-key baseline
```

5. Codex-only 최적화 실행:

```bash
# Codex-only 최적화
bun run prompt-refiner:codex -- --changed-only --fresh --iterations 4

# 로컬 배선 점검용 무-API smoke 모드
bun run prompt-refiner:codex:smoke

# export + optimize 일괄 실행
bun run prompt-refiner:codex:pipeline
```

6. (선택) GEPA 최적화 + 런타임 정책 자동 반영:

```bash
# export + GEPA optimize + 최적 정책을 ~/.mudcode/prompt-refiner-active-policy.txt 로 활성화
bun run prompt-refiner:gepa:pipeline

# GEPA 최적화만 실행 (자동 활성화 없음)
bun run prompt-refiner:gepa
```

선택 환경 변수:
- `MUDCODE_CODEX_OPT_MODEL` (선택 `codex exec --model <name>` 오버라이드)
- `MUDCODE_GEPA_ACTIVATE_MIN_IMPROVEMENT` (기본값 `0.01`, GEPA 자동 활성화 게이트)
- `MUDCODE_GEPA_DEDUPE_KEY` (선택 dedupe 전략 오버라이드: `baseline|baseline-candidate`)
- `MUDCODE_GEPA_SPLIT_KEY` (선택 split 전략 오버라이드: `sample|baseline`)

참고:
- `prompt-refiner:codex`는 `codex exec` 비대화식 실행을 사용하므로 Codex 로그인/인증이 먼저 되어 있어야 합니다.
- `prompt-refiner:gepa*` 스크립트는 재현 가능한 실행을 위해 `uvx`에서 `gepa==0.1.0`으로 고정되어 있습니다.
- Exporter 기본값은 하위 호환을 위해 `--dedupe-key baseline`, `--split-key sample`을 유지합니다.
- 파이프라인은 `--dedupe-key baseline-candidate --split-key baseline`을 사용해 baseline 변형을 보존하면서 train/val 누수를 막습니다.
- `prompt-refiner:gepa:pipeline`은 활성화 성공 시 `~/.mudcode/config.json`의 `promptRefinerPolicyPath`를 자동 갱신합니다.
- `prompt-refiner:gepa:pipeline`은 기본적으로 `valImprovement >= 0.01`일 때만 자동 활성화합니다.
- 정책 경로를 수동 지정하려면 `mudcode config --prompt-refiner-policy-path <path>`를 사용하세요.

모드:
- `off` (기본값): 비활성화
- `shadow`: 정제 후보를 로그로만 저장, 실제 전송은 원문
- `enforce`: 정제 결과를 실제 전송

빠른 프리셋:
- `mudcode config --prompt-refiner-preset safe` (롤백 프리셋: `mode=shadow`, 정책 경로 해제)
- `mudcode config --prompt-refiner-preset enforce-policy` (`mode=enforce`, 기존 정책 경로 또는 `~/.mudcode/prompt-refiner-active-policy.txt` 사용)

Doctor 안전 점검:
- `mudcode doctor`는 `mode=enforce`인데 정책 경로가 없으면 경고합니다.
- `mudcode doctor --fix`는 해당 경우 자동으로 `shadow`로 완화합니다.

## Discord 런타임 명령

매핑된 채널/스레드에서 사용:

빠른 목록:
- 일반 텍스트(슬래시 없음, 기본): 매핑된 agent로 바로 전달
- `/send <text>` (명시적 전송 경로)
- `/orchestrator enable|disable [supervisorInstanceId|supervisor=<id>] [hidden|thread|channel]` (고급/수동 토글, `/help all`에 표시)

- `/help [all]` (alias: `/commands [all]`; 기본 = 카테고리 요약, `all` = 고급 orchestrator 명령 포함)
- `/retry`
- `/health`
- `/snapshot`
- `/io` (Codex I/O 추적 상태 + 최신 transcript 경로 확인)
- `/repair [doctor-only|restart-only|verify|deep]` (기본값: `doctor --fix` 실행 후 데몬 재시작 예약, `verify/deep`는 현재 프로젝트로 자동 스코프)
- `/orchestrator status|run|spawn|remove|enable|disable` (수동 supervisor/worker 오케스트레이션 제어, 기본 비활성화)
  - run 사용법: `/orchestrator run <workerInstanceId> [--priority high|normal|low] <task>` (또는 `p2|p1|p0 <task>`)
  - spawn 사용법: `/orchestrator spawn [count]` (기본 `1`, 최대 `15`)
  - remove 사용법: `/orchestrator remove <workerInstanceId>`
- `/subagents list|send|steer|spawn|info|log|kill` (OpenClaw 스타일 수동 alias, 기본 비활성화)
  - send 사용법: `/subagents send <workerInstanceId> [--priority high|normal|low] <task>`
  - info 사용법: `/subagents info <workerInstanceId|#index>`
  - log 사용법: `/subagents log <workerInstanceId|#index> [tailLines]`
  - kill 사용법: `/subagents kill <workerInstanceId|all>`
- `/enter [count]`, `/tab [count]`, `/esc [count]`, `/up [count]`, `/down [count]`
- `/q` (세션 + 채널 종료)
- `/qw` (채널 아카이브 + 세션 종료)

Orchestrator 큐 튜닝:
- `AGENT_DISCORD_ORCHESTRATOR_QUEUE_MAX_DEPTH` (기본값 `32`)
- `AGENT_DISCORD_ORCHESTRATOR_QUEUE_DRAIN_INTERVAL_MS` (기본값 `1200`)
- `AGENT_DISCORD_ORCHESTRATOR_QUEUE_WAIT_TIMEOUT_MS` (기본값 `600000`)
- `AGENT_DISCORD_ORCHESTRATOR_QUEUE_MAX_RETRIES` (기본값 `2`)
- `AGENT_DISCORD_ORCHESTRATOR_QUEUE_RETRY_BACKOFF_MS` (기본값 `1500`)
- `AGENT_DISCORD_ORCHESTRATOR_QOS_MAX_CONCURRENCY` (기본값 `2`, 동시에 active 가능한 worker 상한)

Orchestrator 자동화:
- `AGENT_DISCORD_ORCHESTRATOR_AUTO_ENABLE=1|0` (기본값 `1`, multi-codex worker가 있으면 자동 활성화)
- `AGENT_DISCORD_ORCHESTRATOR_AUTO_VISIBILITY=hidden|thread|channel` (기본값 `hidden`)
- `AGENT_DISCORD_ORCHESTRATOR_AUTO_DISPATCH_MODE=off|continue|auto|always` (기본값 `auto`)
- `AGENT_DISCORD_ORCHESTRATOR_AUTO_DISPATCH_MAX_WORKERS=<n>` (기본값 `1`, auto fanout 발주 시 최대 worker 수; 최대 `15`)
- `AGENT_DISCORD_ORCHESTRATOR_AUTO_SPAWN=1|0` (기본값 `1`, auto-dispatch에 worker가 없으면 codex worker 자동 프로비저닝)
- `AGENT_DISCORD_ORCHESTRATOR_AUTO_SPAWN_WORKERS=<n>` (기본값 `2`, 자동 생성 worker 수; 최대 `15`)
- `AGENT_DISCORD_ORCHESTRATOR_AUTO_CLEANUP_UNUSED_WORKERS=1|0` (기본값 `1`, 유휴 동적 worker 자동 정리)
- `AGENT_DISCORD_ORCHESTRATOR_AUTO_CLEANUP_INTERVAL_MS=<n>` (기본값 `60000`, 정리 스캔 주기; 최소 `5000`)
- `AGENT_DISCORD_ORCHESTRATOR_AUTO_CLEANUP_IDLE_MS=<n>` (기본값 `300000`, worker teardown 전 유휴 시간 임계값)
- `AGENT_DISCORD_ORCHESTRATOR_AUTO_CLEANUP_MAX_REMOVALS=<n>` (기본값 `2`, 정리 1회당 제거 최대 worker 수; 최대 `15`)
- `AGENT_DISCORD_ORCHESTRATOR_AUTO_PLANNER=1|0` (기본값 `1`, auto fanout 시 planner task 분할 활성화)
- `AGENT_DISCORD_ORCHESTRATOR_AUTO_PLANNER_PROMPT_MAX_CHARS=<n>` (기본값 `1600`, planner payload에 포함되는 원문 최대 길이)
- `AGENT_DISCORD_ORCHESTRATOR_CONTEXT_BUDGET_CHARS=<n>` (기본값 `2600`, task-packet 컨텍스트 예산 게이트)
- `AGENT_DISCORD_ORCHESTRATOR_ROLLING_SUMMARY_MAX_ITEMS=<n>` (기본값 `6`, rolling summary 항목 상한)
- `AGENT_DISCORD_ORCHESTRATOR_ROLLING_SUMMARY_MAX_CHARS=<n>` (기본값 `900`, rolling summary 문자 예산)
- `AGENT_DISCORD_ORCHESTRATOR_PACKET_INLINE_MAX_CHARS=<n>` (기본값 `1800`, 초과 시 packet 파일 외부화)
- `AGENT_DISCORD_ORCHESTRATOR_PACKET_ARTIFACT_ENABLED=1|0` (기본값 `1`, 큰 task packet을 `.mudcode/orchestrator/packets/*.md`에 저장)
- `AGENT_DISCORD_ORCHESTRATOR_MANUAL_COMMANDS=1|0` (기본값 `0`, `/orchestrator` 및 `/subagents` 수동 런타임 명령 활성화)

Self-check:
- `bun run orchestrator:auto:check` (auto enable/spawn/planner dispatch 회귀 점검)
- `bun run ops:self-heal` (build + `repair deep` 원샷 셀프힐: doctor fix + restart + verify)
- `bun run ops:verify:fast` (config/capture/router/index 빠른 회귀 점검)
- `bun run ops:verify:gepa` (GEPA/prompt-refiner 회귀 세트: typecheck + TS/Python/Rust 점검 + help smoke)

## Codex I/O v2

- Codex 기본 실행 옵션에 `--no-alt-screen`이 포함되어 tmux 스크롤백 확인이 쉬워졌습니다.
- Codex turn I/O transcript를 JSONL로 저장합니다: `~/.mudcode/io-v2/<project>/<instance>/YYYY-MM-DD.jsonl`
- 출력에서 명령 패턴이 감지되면, 매핑 채널에 명령 시작/종료 요약을 보냅니다.
- `AGENTS.md`의 `### Available skills`를 기반으로 Codex 프롬프트에 자동 skill 힌트를 붙일 수 있습니다.

환경 변수:
- Gemini preflight fallback:
  - `AGENT_DISCORD_GEMINI_PREFLIGHT_ENABLED=1|0` : 기본값 `1`, 런타임 디스패치 전에 Gemini 모델 사용 가능 여부 사전 점검
  - `AGENT_DISCORD_GEMINI_PREFLIGHT_MODEL=<model>` : 기본값 `pro 3.1`, preflight probe 대상 모델 문자열
  - `AGENT_DISCORD_GEMINI_PREFLIGHT_CACHE_TTL_MS=<n>` : 기본값 `60000`, preflight probe 결과 캐시 TTL(ms)
- Turn-route ledger:
  - `AGENT_DISCORD_TURN_ROUTE_RETENTION_MS=<n>` : 기본값 `21600000`, 범위 `60000..86400000`, event 라우팅 fallback용 turn->channel 힌트 유지 시간
  - `AGENT_DISCORD_TURN_ROUTE_MAX=<n>` : 기본값 `20000`, 범위 `100..200000`, 메모리 내 turn route 엔트리 최대치(초과 시 오래된 항목부터 제거)
- `AGENT_DISCORD_CODEX_IO_V2=0` : 추적기 비활성화
- `AGENT_DISCORD_CODEX_IO_V2_ANNOUNCE=0` : transcript는 저장하고 채널 이벤트 메시지만 비활성화
- `AGENT_DISCORD_CODEX_IO_V2_DIR=/path` : transcript 저장 루트 경로 변경
- `MUDCODE_CODEX_AUTO_SKILL_LINK=0` : 자동 skill 힌트 비활성화
- `MUDCODE_STATE_LAST_ACTIVE_SAVE_DEBOUNCE_MS=<n>` : 기본값 `1500`, 범위 `100..60000`, `lastActive` 상태 저장 디바운스 간격
- `AGENT_DISCORD_CODEX_AUTO_SUBAGENT_THREAD_CAP=<n>` : 기본값 `6`, Codex 프롬프트에 주입되는 `spawn_agent` 병렬 상한 힌트 값
- `AGENT_DISCORD_CODEX_AUTO_LONGTASK_REPORT_MODE=continue|auto|always|off` : 긴 작업 실행/보고 스타일 힌트 자동 주입 (`continue` 기본값)
- `AGENT_DISCORD_CODEX_AUTO_LANGUAGE_POLICY_MODE=off|korean|always` : 기본값 `off`, 필요한 경우에만 `korean`/`always`로 명시 설정
- `AGENT_DISCORD_CAPTURE_FINAL_BUFFER_MAX_CHARS=<n>` : 기본값 `120000`, 범위 `4000..500000`, final-only capture 버퍼 잘림 기준
- `AGENT_DISCORD_EVENT_PROGRESS_TRANSCRIPT_MAX_CHARS=<n>` : 기본값 `100000`, 범위 `500..500000`, 빈 `session.final` 보완용 transcript 예산
- `AGENT_DISCORD_EVENT_PROGRESS_MAX_MESSAGES_PER_TURN=<n>` : 기본값 `6`, 범위 `0..200`, 턴 단위 progress burst guard (`0`이면 억제 비활성화)
- `AGENT_DISCORD_EVENT_PROGRESS_MAX_CHARS_PER_TURN=<n>` : 기본값 `6000`, 범위 `0..200000`, 턴 단위 progress 텍스트 예산(초과분 suppress, `0`이면 char budget 비활성화)
- `AGENT_DISCORD_EVENT_PROGRESS_DUPLICATE_WINDOW_MS=<n>` : 기본값 `10000`, 범위 `0..600000`, 동일 progress payload 반복 전송 억제 윈도우 (`0`이면 중복 억제 비활성화)
- `AGENT_DISCORD_EVENT_PROGRESS_MODE_STALE_WARN_MS=<n>` : 기본값 `90000`, 범위 `5000..3600000`, pending 상태에서 Codex progress-mode 런타임 신호가 오래됐을 때 health 경고 임계값
- `AGENT_DISCORD_EVENT_HOOK_OUTBOX_MAX=<n>` : 기본값 `2000`, 범위 `1..20000`, hook 이벤트 메모리 큐 최대 길이(초과 시 오래된 항목을 drop하며 `session.progress`를 우선 정리)
- `AGENT_DISCORD_EVENT_HOOK_OUTBOX_PATH=<path|off>` : 기본값 `~/.mudcode/runtime/agent-event-hook-outbox.json`, hook outbox 영속 경로(`off`로 설정하면 비활성화)
- `AGENT_DISCORD_EVENT_HOOK_OUTBOX_FLUSH_MS=<n>` : 기본값 `200`, 범위 `0..10000`, outbox 파일 flush 주기(`0`이면 동기 flush)
- `AGENT_DISCORD_EVENT_HOOK_OUTBOX_RETENTION_MS=<n>` : 기본값 `86400000`, 범위 `1000..604800000`, 재시작 시 복원 가능한 outbox 항목 최대 보관 시간
- `AGENT_DISCORD_OUTPUT_DEDUPE_WINDOW_MS=<n>` : 기본값 `2500`, 범위 `0..60000`, 동일 텍스트 출력 폭주 억제 윈도우(`0`이면 비활성화)
- `AGENT_DISCORD_OUTPUT_MAX_CHUNKS=<n>` : 기본값 `4`, 범위 `1..40`, 1회 전송당 Discord 텍스트/페이지 청크 fan-out 상한(초과 시 마지막에 truncation notice 추가)
- `AGENT_DISCORD_LONG_OUTPUT_THREAD_MAX_CHUNKS=<n>` : 기본값 `8`, 범위 `1..200`, long-output 예상 청크가 상한을 넘으면 thread fan-out 대신 condensed 요약만 전송
- `AGENT_DISCORD_INPUT_DEDUPE_MESSAGE_WINDOW_MS=<n>` : 기본값 `1800000`, 범위 `0..86400000`, 동일 messageId 중복 디스패치 차단 윈도우
- `AGENT_DISCORD_INPUT_DEDUPE_SIGNATURE_WINDOW_MS=<n>` : 기본값 `5000`, 범위 `0..3600000`, messageId 없는 slash/control 이벤트의 서명 기반 단기 중복 차단 윈도우
- `AGENT_DISCORD_INPUT_DEDUPE_MAX=<n>` : 기본값 `50000`, 범위 `100..1000000`, 입력 중복 차단 캐시 최대 엔트리 수
- `AGENT_DISCORD_TMUX_DEFER_MISSING_ENABLED=1|0` : 기본값 `1`, tmux target 누락 시 즉시 실패 대신 자동 재시도 큐로 지연 전달
- `AGENT_DISCORD_TMUX_DEFER_MISSING_RETRY_BASE_MS=<n>` : 기본값 `2500`, 범위 `250..60000`, 지연 전달 재시도 기본 backoff
- `AGENT_DISCORD_TMUX_DEFER_MISSING_RETRY_MAX_MS=<n>` : 기본값 `15000`, 범위 `500..120000`, 지연 전달 재시도 최대 backoff
- `AGENT_DISCORD_TMUX_DEFER_MISSING_RETRY_MAX_ATTEMPTS=<n>` : 기본값 `24`, 범위 `1..200`, 지연 전달 최대 재시도 횟수
- `AGENT_DISCORD_TMUX_DEFER_MISSING_MAX_AGE_MS=<n>` : 기본값 `600000`, 범위 `10000..86400000`, 지연 전달 큐 항목 최대 유지 시간
- `AGENT_DISCORD_TMUX_DEFER_MISSING_MAX_QUEUE=<n>` : 기본값 `400`, 범위 `1..5000`, 지연 전달 큐 최대 길이
- `AGENT_DISCORD_BACKGROUND_CLI_SCHEDULE_COOLDOWN_MS=<n>` : 기본값 `15000`, 범위 `0..600000`, 동일 CLI 인자 배경 유지보수 스케줄 중복 억제 윈도우(`0`이면 비활성화)
- `MUDCODE_REPAIR_LOCK_PATH=<path>` : 기본값 `~/.mudcode/locks/repair.lock`, `mudcode repair` 동시 실행 방지용 파일시스템 락 경로
- `MUDCODE_REPAIR_LOCK_WAIT_MS=<n>` : 기본값 `2000`, 범위 `0..30000`, 락 점유 시 대기 후 실패하기까지의 시간(ms)
- `MUDCODE_REPAIR_LOCK_STALE_MS=<n>` : 기본값 `300000`, 범위 `1000..86400000`, stale 락으로 간주해 자동 복구하는 기준(ms)
- `AGENT_DISCORD_CODEX_EVENT_POC=1|0` : 기본값 `1`, Codex 로컬 event-hook 브리지 사용 (`0`이면 legacy direct capture 출력 경로)
- `AGENT_DISCORD_CODEX_EVENT_ONLY` : deprecated/ignored (런타임 영향 없음; Codex 안전 게이트는 항상 유지: `session.progress` channel -> thread/off, `session.idle` 기본 억제)
- `AGENT_DISCORD_CODEX_EVENT_ONLY_IDLE_OUTPUT=1|0` : 기본값 `0`, debug/legacy 용도에서만 Codex `session.idle` 채널 출력을 임시 허용
- `AGENT_DISCORD_CODEX_FORCE_EVENT_OUTPUT=1|0` : 기본값 `1`, event-hook 브리지가 활성화된 Codex 출력은 event 경로를 authoritative로 유지 (`0`이어도 hook 전달이 살아 있으면 direct fallback은 다시 켜지지 않음)
- `AGENT_DISCORD_EVENT_HOOK_CAPTURE_OUTPUT=1|0` : 기본값 `0`, event-hook stale-capture fallback 동안 non-codex 인스턴스의 legacy raw direct 출력은 `1`일 때만 허용
- `AGENT_DISCORD_EVENT_LIFECYCLE_STRICT_MODE=off|warn|reject` : 기본값 `warn`
- `AGENT_DISCORD_SUPERVISOR_FINAL_FORMAT_STRICT=0|1` : 기본값 `1`, supervisor final-format 자동 재요청 검증을 엄격 모드로 수행

## 업그레이드 / 제거

업그레이드:

```bash
bun add -g @mudramo/mudcode@latest
```

제거:

```bash
mudcode uninstall
```

## 설치 트러블슈팅

- `mudcode: command not found`: Bun 글로벌 경로(`~/.bun/bin`)를 PATH에 추가하거나 글로벌 재설치
- `tmux not found`: tmux 먼저 설치 (`brew install tmux`, `sudo apt install tmux`)
- 플랫폼 바이너리 누락: 최신 버전으로 업데이트 후 재시도, 계속 실패하면 해당 머신에서 소스 실행

## 릴리즈 자동화

GitHub Actions로 릴리즈 자동화가 구성되어 있습니다.

- `main` 푸시: patch 버전 자동 증가 + 태그 생성
- 태그(`v*`) 푸시: `full` 프로필 배포 실행 (Linux/macOS/Windows 타깃)

워크플로 파일:

- `.github/workflows/auto-version-bump.yml`
- `.github/workflows/release-publish.yml`

## 문서

- `docs/setup/DISCORD_SETUP.ko.md`
- `docs/setup/SLACK_SETUP.ko.md`
- `docs/release/RELEASE_NPM.ko.md`
- `ARCHITECTURE.md`
- `DEVELOPMENT.md`

## 출처 / Provenance

- 확인된 출처 저장소(히스토리 근거): README 커밋 `795008e`(2026-02-11, `docs: add derived-from attribution in readme`)에서 본 프로젝트가 [`DoBuDevel/discord-agent-bridge`](https://github.com/DoBuDevel/discord-agent-bridge)에서 파생되었다고 명시합니다. `ada85e5`(2026-02-09)도 clone/support 링크를 동일 저장소로 가리킵니다.
- 유입/적응된 기준 영역(히스토리 근거): 이 저장소의 최초 커밋 `fd8b9da`(2026-02-05)부터 `src/discord/**`, `src/tmux/**`, `src/state/**`, `src/config/**`, `src/agents/**`, `src/index.ts`, `src/daemon.ts`가 존재하며 현재 트리에서도 유지됩니다.
- 로컬 재작성: 이후 커밋에서 `agent-messenger-bridge` -> `discode` -> `mudcode` 리브랜딩, Slack 지원, Codex 런타임/오케스트레이션, 릴리즈 패키징이 크게 확장/재구성되었습니다.
- 라이선스/크레딧(로컬 근거 기준): 현재 저장소 라이선스는 MIT(`LICENSE`, `package.json`)입니다. 히스토리에 원 저작자 표기 문구가 존재하지만, 정확한 파일 단위 import 경계는 로컬 메타데이터만으로 확정할 수 없습니다.

## 라이선스

MIT
