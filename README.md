# zai-plugin-cc

> Claude Code 옆에 두는 **Z.AI (GLM-4.6 / GLM-4.5-Air)** 보조 두뇌 플러그인.
>
> Codex 플러그인의 위임 패턴을 차용해, GLM 에게 코드 생성·리뷰·설계 상담을 맡긴다.

## 무엇을 하는가

- `/zai:setup` — Z.AI API 키 한 번 등록하면 끝
- `/zai:ask` — 짧은 질문은 빠른 `glm-4.5-air` 로 즉답
- `/zai:code` — 큰 코드 작업 위임 (백그라운드 가능)
- `/zai:review` — `git diff` 를 GLM 에 넘겨 제3자 코드 리뷰
- `/zai:consult` — 설계/전략 상담
- `/zai:status` · `/zai:result` · `/zai:cancel` — 백그라운드 job 관리

GLM 호출은 모두 `scripts/zai-companion.mjs` 한 군데를 거치므로, 메인 Claude 세션은 외부 호출에서 격리된다. 인증 실패나 모델 오류가 메인 작업을 끊지 않는다.

## 설치

### 1. 플러그인 등록

로컬 경로로 등록하는 가장 빠른 방법:

```bash
# Claude Code 에서
/plugin install /Users/kwanghyeonkim/Project/zai-plugin-cc
```

또는 직접 마켓플레이스 캐시에 심볼릭 링크:

```bash
ln -s /Users/kwanghyeonkim/Project/zai-plugin-cc \
      ~/.claude/plugins/local/zai-plugin-cc
```

### 2. API 키 등록

```text
/zai:setup
```

실행하면 Claude Code 가 키 입력을 요청한다. 받은 키는

- `~/.config/zai-plugin-cc/config.json` 에 mode 0600 으로 저장
- `GET /api/paas/v4/models` 로 검증 후 사용 가능 모델 목록 표시

CI 등 비대화형 환경에서는 환경변수로:

```bash
export ZAI_API_KEY=sk-zai-xxxxxxxxx
```

키 발급: https://z.ai/model-api

## 사용 예시

```text
# 빠른 단발 질문
/zai:ask 이 정규식 ^(a+)+$ 가 왜 ReDoS 위험한지 알려줘

# 큰 코드 위임 (백그라운드 추천)
/zai:code src/auth/jwt.ts 에 만료 시간 갱신 로직 추가해줘

# git diff 리뷰
/zai:review

# 설계 상담
/zai:consult 주문 처리에 큐를 넣을지 SSE 로 끝낼지 트레이드오프 봐줘

# 백그라운드 job 추적
/zai:status
/zai:result 01HZAB-deadbeef
/zai:cancel 01HZAB-deadbeef
```

## 디렉토리 구조

```text
zai-plugin-cc/
├── .claude-plugin/plugin.json    플러그인 매니페스트
├── agents/zai-consultant.md      얇은 포워더 서브에이전트
├── commands/                     슬래시 명령 8개
├── skills/                       내부 호출 계약 + 프롬프트 가이드
├── scripts/
│   ├── zai-companion.mjs         진입점 (setup/ask/code/review/consult/...)
│   └── lib/
│       ├── config.mjs            토큰·설정
│       ├── client.mjs            Z.AI fetch 래퍼
│       ├── jobs.mjs              .zai/jobs 상태 관리
│       ├── runner.mjs            foreground/background 실행기
│       └── prompts.mjs           모드별 프롬프트 템플릿
└── docs/                         FEATURES / MVP / ARCHITECTURE
```

## 환경 변수

| 변수 | 기본값 | 용도 |
|------|--------|------|
| `ZAI_API_KEY` | — | API 키 (저장된 config 보다 우선) |
| `ZAI_BASE_URL` | `https://api.z.ai/api/paas/v4` | OpenAI 호환 엔드포인트 |
| `ZAI_DEFAULT_MODEL` | `glm-4.6` | code/review/consult 기본 모델 |
| `ZAI_LIGHT_MODEL` | `glm-4.5-air` | ask 기본 모델 |
| `ZAI_DEBUG` | — | `1` 이면 stderr 에 HTTP 요청 추적 |
| `ZAI_CONFIG_DIR` | `~/.config/zai-plugin-cc` | 설정 파일 위치 |
| `ZAI_JOBS_DIR` | `<repo>/.zai/jobs` | job 파일 위치 |

## 문서

- [`docs/FEATURES.md`](docs/FEATURES.md) — 기능 분석
- [`docs/MVP.md`](docs/MVP.md) — MVP 범위와 명령어 사양
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — 아키텍처 / 데이터 흐름

## 보안

- API 키는 `~/.config/zai-plugin-cc/config.json` (0600) 에만 저장. 저장소 안에 떨어지지 않도록 `.gitignore` 에 `.zai/`, `.env`, `zai-config.json` 등록됨.
- 사용자 코드는 명시적으로 위임된 부분만 Z.AI 로 전송 — `/zai:review` 가 `git diff` 일부를 보내는 것이 유일한 자동 첨부.
- job 결과는 `.zai/jobs/` 에 14 일 보관 후 GC. 즉시 지우려면 디렉토리 통째로 삭제.

## 미완·확장 슬롯

| 슬롯 | 비고 |
|------|------|
| 스트리밍(SSE) 인 라이브 표시 | 현재는 완료 후 일괄 출력 |
| Stop 훅 자동 리뷰 게이트 | `hooks/hooks.json` 비어 있음 |
| `--resume-last` 멀티턴 | 현재 모든 호출은 단발 |
| 멀티 프로필 (개인/회사 토큰) | 단일 키만 |
| Tool use / function calling 위임 | MVP 비대상 |

## 라이선스

MIT (예정)
