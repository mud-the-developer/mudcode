# Discode npm 배포 가이드

`discode`는 플랫폼별 바이너리 패키지 + 메타 패키지(`@<scope>/discode`)로 배포합니다.

## 1) 사전 준비

- 작업 위치: 저장소 루트의 `discode/`
- `bun`, `npm`, `cargo`(Rust sidecar를 포함할 경우)가 설치되어 있어야 함
- npm 계정은 publish 권한이 있어야 하고, 2FA 사용 시 Automation token 권장

```bash
cd /home/mud/repo/discode_archlinux/discode
bun --version
npm whoami
```

Automation token 설정:

```bash
npm config set //registry.npmjs.org/:_authToken=YOUR_AUTOMATION_TOKEN
npm whoami
```

## 2) 버전 동기화

`package.json`의 아래 값을 동일 버전으로 올립니다.

- `version`
- `optionalDependencies`의 `@<scope>/discode-*` (루트 패키지를 직접 배포할 경우)

예: `0.6.2` -> `0.6.3`

## 3) 빌드/패키징

```bash
npm run typecheck
npm run build
npm run build:release
npm run pack:release
npm run publish:release:dry-run
```

단일 플랫폼만 빠르게 확인할 때:

```bash
npm run build:release:binaries:single
```

## 4) Rust sidecar 포함 (선택)

`DISCODE_DAEMON_RUNTIME=rust`를 배포 패키지에서 바로 쓰려면 `discode-rs`를 함께 넣을 수 있습니다.

- `DISCODE_RS_BIN`: 모든 타깃에 공통 바이너리 경로
- `DISCODE_RS_BIN_<SUFFIX>`: 타깃별 바이너리 경로 (예: `DISCODE_RS_BIN_LINUX_X64`)
- `DISCODE_RS_PREBUILT_DIR`: `discode-rs-*` 사전 빌드 바이너리 디렉터리
- 경로를 지정하지 않았고 호스트 타깃이면, `build-binaries`가 기본적으로 `discode-rs/`에서 `cargo build --release`를 자동 시도
- `DISCODE_RS_SKIP_LOCAL_BUILD=1`: 위 자동 빌드 비활성화

예시:

```bash
DISCODE_RS_PREBUILT_DIR=/path/to/prebuilt npm run build:release:binaries
```

배포 스코프를 내 npm 계정으로 바꾸려면:

```bash
DISCODE_NPM_SCOPE=@your-npm-id npm run build:release
```

## 5) 산출물 확인

- 플랫폼 패키지: `dist/release/discode-*`
- 메타 패키지: `dist/release/npm/discode`
- 바이너리: `dist/release/discode-*/bin/discode`
- Rust sidecar 포함 시: `dist/release/discode-*/bin/discode-rs`

## 6) 한 번에 배포 (권장)

```bash
DISCODE_NPM_SCOPE=@your-npm-id npm run publish:release
```

- 내부적으로 `build:release`를 실행한 뒤 플랫폼 패키지 + 메타 패키지를 순차 publish 합니다.
- 업로드 전에 검증만 하려면:

```bash
DISCODE_NPM_SCOPE=@your-npm-id npm run publish:release:dry-run
```

Bun으로 publish 하려면:

```bash
DISCODE_NPM_SCOPE=@your-npm-id npm run publish:release:bun
```

로컬 머신에서 현재 OS/아키텍처만 배포하려면:

```bash
DISCODE_NPM_SCOPE=@your-npm-id npm run publish:release:bun:single
```

## 7) 멀티 플랫폼 전체 배포 (GitHub Actions 권장)

로컬 한 대에서 모든 OS 타깃을 완전하게 만들기 어렵기 때문에, 워크플로우로 OS 매트릭스 빌드 후 한 번에 publish 하는 방식을 권장합니다.

- 워크플로우 파일: `.github/workflows/release-publish.yml`
- 빌드 대상: Linux x64/arm64, macOS x64/arm64, Windows x64
- 필수 시크릿: `NPM_TOKEN`

실행 방법:

1. GitHub 저장소 Settings -> Secrets and variables -> Actions 에 `NPM_TOKEN` 등록
2. Actions 탭 -> `Release Publish` 선택
3. 입력값:
   - `scope`: `@your-npm-id`
   - `tag`: `latest` (또는 `next`)
   - `dry_run`: 먼저 `true`로 검증, 이후 `false`로 실제 배포

## 8) 플랫폼 패키지 수동 배포

```bash
npm publish --access public --workspaces=false dist/release/discode-darwin-arm64
npm publish --access public --workspaces=false dist/release/discode-darwin-x64
npm publish --access public --workspaces=false dist/release/discode-darwin-x64-baseline
npm publish --access public --workspaces=false dist/release/discode-linux-arm64
npm publish --access public --workspaces=false dist/release/discode-linux-arm64-musl
npm publish --access public --workspaces=false dist/release/discode-linux-x64
npm publish --access public --workspaces=false dist/release/discode-linux-x64-baseline
npm publish --access public --workspaces=false dist/release/discode-linux-x64-baseline-musl
npm publish --access public --workspaces=false dist/release/discode-linux-x64-musl
npm publish --access public --workspaces=false dist/release/discode-windows-x64
npm publish --access public --workspaces=false dist/release/discode-windows-x64-baseline
```

## 9) 메타 패키지 수동 배포

```bash
npm publish --access public --workspaces=false dist/release/npm/discode
```

## 10) 배포 확인

```bash
npm view @your-npm-id/discode version
npm view @your-npm-id/discode-darwin-arm64 version
npm view @your-npm-id/discode-linux-x64 version
```

설치 확인:

```bash
npm i -g @your-npm-id/discode@latest
discode --version
```

## 문제 해결

### `EOTP`

- Automation token이 아니거나 계정 정책이 `auth-and-writes`이면 발생 가능
- Automation token 재발급 후 다시 설정

### `You cannot publish over the previously published versions`

- 같은 버전 재배포 시 정상 에러
- 버전을 올린 뒤 다시 빌드/배포

### `Not found` / `Access token expired or revoked`

- 토큰 만료/폐기 혹은 인증 꼬임
- `npm whoami` 재확인 후 토큰 재설정

## 릴리즈 후 권장 작업

- 버전/스크립트 변경 사항 커밋
- 필요 시 npm 토큰 revoke 및 재발급
