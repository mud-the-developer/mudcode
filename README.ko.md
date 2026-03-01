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
```

모드:
- `off` (기본값): 비활성화
- `shadow`: 정제 후보를 로그로만 저장, 실제 전송은 원문
- `enforce`: 정제 결과를 실제 전송

## Discord 런타임 명령

매핑된 채널/스레드에서 사용:

- `/retry`
- `/health`
- `/snapshot`
- `/io` (Codex I/O 추적 상태 + 최신 transcript 경로 확인)
- `/enter [count]`, `/tab [count]`, `/esc [count]`, `/up [count]`, `/down [count]`
- `/q` (세션 + 채널 종료)
- `/qw` (채널 아카이브 + 세션 종료)

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
