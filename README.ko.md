# Mudcode

AI 에이전트 CLI를 tmux 기반으로 Discord/Slack에 연결하는 브리지입니다.

English: [README.md](README.md)

## Mudcode가 하는 일

- AI CLI를 tmux에서 실행 (프로젝트 인스턴스별 윈도우)
- 훅 서버를 통해 에이전트 출력을 Discord/Slack으로 전달
- 채팅 입력을 tmux pane으로 다시 라우팅
- 프로젝트/채널/세션 수명주기를 CLI에서 관리

지원 에이전트:

- Claude Code
- Gemini CLI
- OpenCode
- OpenAI Codex CLI

## 요구 사항

- Bun `>=1.3`
- tmux `>=3.0`
- Discord 봇 토큰(또는 Slack bot/app 토큰)
- 지원되는 AI CLI 중 최소 1개 로컬 설치

## 설치

```bash
npm install -g @mudramo/mudcode
# 또는
bun add -g @mudramo/mudcode
```

바이너리 설치:

```bash
curl -fsSL https://mudcode.chat/install | bash
```

## 빠른 시작

```bash
mudcode onboard
cd ~/projects/my-app
mudcode new
```

자주 쓰는 변형:

```bash
mudcode new claude
mudcode new codex --instance codex-2
mudcode attach my-app --instance codex-2
mudcode stop my-app --instance codex-2
```

## 핵심 명령어

- `mudcode tui`: 인터랙티브 터미널 UI (기본 명령)
- `mudcode onboard`: 초기 1회 설정
- `mudcode new [agent]`: 프로젝트 인스턴스 생성/재개
- `mudcode daemon <start|stop|status|restart>`: 데몬 관리
- `mudcode list`: 프로젝트/인스턴스 목록
- `mudcode status`: 설정 + tmux/프로젝트 상태 확인
- `mudcode health [--json]`: 설정/데몬/tmux/채널 매핑 진단 실행
- `mudcode attach [project]`: tmux 세션/윈도우 연결
- `mudcode stop [project]`: 프로젝트 또는 단일 인스턴스 중지
- `mudcode config --show`: 현재 설정 확인
- `mudcode agents`: 감지된 에이전트 어댑터 목록
- `mudcode uninstall`: mudcode 제거

상세 옵션은 도움말에서 확인:

```bash
mudcode --help
mudcode new --help
mudcode config --help
```

## Bun 배포 플로우

`mudcode/` 디렉토리에서 실행:

```bash
npm run release:verify:bun
npm run release:publish:bun
```

Linux 전용 프로파일:

```bash
npm run release:verify:bun:linux
npm run release:publish:bun:linux
```

현재 머신 단일 타깃 배포:

```bash
npm run release:verify:bun:single
npm run release:publish:bun:single
```

## 개발

```bash
bun install
npm run typecheck
npm test
npm run test:e2e:tmux
npm run ci:local
npm run migration:check
npm run build
```

## 문서

- `docs/DISCORD_SETUP.ko.md`
- `docs/SLACK_SETUP.ko.md`
- `docs/RELEASE_NPM.ko.md`
- `ARCHITECTURE.md`
- `DEVELOPMENT.md`

## 라이선스

MIT
