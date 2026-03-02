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
- `mudcode health [--json]`: 진단 실행
- `mudcode daemon <start|stop|status|restart>`: 데몬 관리
- `mudcode stop [project] --instance <id>`: 특정 인스턴스 중지
- `mudcode skill list [--all]`: `AGENTS.md`와 `.agents/skills` 기반 스킬 목록/상태 확인
- `mudcode skill install [name]`: 로컬/no-api 스킬을 Codex 스킬 디렉토리에 설치
- `mudcode config --show`: 현재 설정 출력
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
# bun run prompt-refiner:export-gepa -- --val-ratio 0.2 --all
# JS fallback:
# bun run prompt-refiner:export-gepa:js -- --val-ratio 0.2 --all
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

참고:
- `prompt-refiner:codex`는 `codex exec` 비대화식 실행을 사용하므로 Codex 로그인/인증이 먼저 되어 있어야 합니다.
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

- `/retry`
- `/health`
- `/snapshot`
- `/io` (Codex I/O 추적 상태 + 최신 transcript 경로 확인)
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

## Codex I/O v2

- Codex 기본 실행 옵션에 `--no-alt-screen`이 포함되어 tmux 스크롤백 확인이 쉬워졌습니다.
- Codex turn I/O transcript를 JSONL로 저장합니다: `~/.mudcode/io-v2/<project>/<instance>/YYYY-MM-DD.jsonl`
- 출력에서 명령 패턴이 감지되면, 매핑 채널에 명령 시작/종료 요약을 보냅니다.
- `AGENTS.md`의 `### Available skills`를 기반으로 Codex 프롬프트에 자동 skill 힌트를 붙일 수 있습니다.

환경 변수:
- `AGENT_DISCORD_CODEX_IO_V2=0` : 추적기 비활성화
- `AGENT_DISCORD_CODEX_IO_V2_ANNOUNCE=0` : transcript는 저장하고 채널 이벤트 메시지만 비활성화
- `AGENT_DISCORD_CODEX_IO_V2_DIR=/path` : transcript 저장 루트 경로 변경
- `MUDCODE_CODEX_AUTO_SKILL_LINK=0` : 자동 skill 힌트 비활성화
- `AGENT_DISCORD_CODEX_AUTO_LONGTASK_REPORT_MODE=continue|auto|always|off` : 긴 작업 실행/보고 스타일 힌트 자동 주입 (`continue` 기본값)
- `AGENT_DISCORD_CODEX_AUTO_LANGUAGE_POLICY_MODE=off|korean|always` : 기본값 `off`, 필요한 경우에만 `korean`/`always`로 명시 설정
- `AGENT_DISCORD_CODEX_EVENT_ONLY=1|0` : 기본값 `1`, `0`이면 기존 direct capture 출력 경로 유지
- `AGENT_DISCORD_CODEX_EVENT_ONLY_CAPTURE_FALLBACK=0|1` : 기본값 `0`, `1`이면 tmux stale fallback capture 재활성화
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

## 라이선스

MIT
