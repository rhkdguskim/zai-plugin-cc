# zai-plugin-cc — 기능 분석

> Claude Code 플러그인. Claude 메인 세션 옆에서 **Z.AI (GLM 시리즈)** 모델을 보조 두뇌로 두고, 코드 생성·리뷰·상담을 위임한다.

## 1. 배경과 영감

| 항목 | 출처 |
|------|------|
| 플러그인 패턴 | OpenAI Codex Claude Code 플러그인 (`@openai/codex` 1.0.4) |
| 모델 제공자 | Z.AI Open Platform (`https://z.ai/model-api`) |
| API 스타일 | OpenAI 호환 (`https://api.z.ai/api/paas/v4/chat/completions`) |
| 인증 | Bearer 토큰 (`ZAI_API_KEY`) |

Codex 플러그인이 **"메인 Claude 옆에 별도 CLI 두뇌를 두고 위임한다"** 는 패턴을 잡아낸 것을, 본 플러그인은 GLM-4.6 / GLM-4.5-Air 라는 다른 색깔의 두뇌로 옮겨 적용한다.

## 2. Z.AI 능력 분석

### 2.1 모델 라인업 (2026-04 기준)

| 모델 | 용도 | 비고 |
|------|------|------|
| `glm-4.6` | 깊은 추론, 코드 생성, 설계 | Sonnet/Opus 급 기본값 |
| `glm-4.5-air` | 빠른 질의, 짧은 응답 | Haiku 급, 저비용 |
| `glm-4.5-flash` | 초저지연 | 자동완성/실시간 |
| `glm-4.5-x` | 멀티모달 (이미지) | 선택적 |

### 2.2 API 표면

- **OpenAI 호환 엔드포인트** — `POST /api/paas/v4/chat/completions`
  - Request: `{ model, messages: [{role, content}], temperature?, max_tokens?, stream? }`
  - Response: 표준 OpenAI chat completion JSON
- **Anthropic 호환 엔드포인트** — `https://api.z.ai/api/anthropic` (Claude Code 자체 모델 교체용. 본 플러그인은 사용 안 함)
- **스트리밍** — SSE 지원 (`stream: true`)
- **컨텍스트** — 모델별 128K~200K 토큰

### 2.3 한계

- 도구 호출(tool use) 포맷이 OpenAI 스타일이라 Anthropic 스타일과 차이 있음 → MVP는 **순수 chat completion** 만 사용
- Vision 입력은 별도 모델 — MVP 비대상
- 일부 리전에서 응답 지연 → 백그라운드 모드 필수

## 3. 사용자 시나리오 매트릭스

| 시나리오 | 명령어 | 모드 | 모델 |
|----------|--------|------|------|
| "이 함수 다시 짜줘" 빠른 단발 질문 | `/zai:ask` | 포그라운드 | `glm-4.5-air` |
| 큰 작업 위임 ("이 모듈 리팩터링해서 코드만 줘") | `/zai:code` | 백그라운드 권장 | `glm-4.6` |
| git diff 코드 리뷰 (제3의 눈) | `/zai:review` | 자동 추정 | `glm-4.6` |
| 설계 상담 ("이 아키텍처 어떻게 생각해") | `/zai:consult` | 백그라운드 | `glm-4.6` |
| 진행 중 job 보기 | `/zai:status` | 즉시 | — |
| 끝난 job 결과 다시 보기 | `/zai:result <id>` | 즉시 | — |
| 백그라운드 job 취소 | `/zai:cancel <id>` | 즉시 | — |
| 토큰 등록 / 헬스체크 | `/zai:setup` | 즉시 | — |

## 4. 핵심 기능 (must-have)

1. **토큰 부트스트랩** — 첫 사용 시 `/zai:setup` 으로 API 키 입력 → 검증 (`/models` 호출) → `~/.config/zai-plugin-cc/config.json` 저장
2. **위임 채널** — 메인 Claude 가 사용자의 자연어 요청을 그대로 GLM 에 넘기고 결과를 **그대로** 사용자에게 반환
3. **하네스 에이전트** — `agents/zai-consultant.md` 는 얇은 포워더. 직접 추론하지 않음
4. **백그라운드 job** — 큰 작업은 detached 프로세스로 실행, 상태/결과는 파일 기반(`.zai/jobs/*.json`)으로 폴링
5. **모델 / 효도(effort) 라우팅** — `--model glm-4.6 / glm-4.5-air`, `--temperature` 플래그
6. **실패 격리** — 토큰 누락 / 네트워크 실패 / 4xx / 5xx 가 메인 세션을 망가뜨리지 않음

## 5. 보조 기능 (nice-to-have, MVP 후)

- 스트리밍 응답 인 라이브 표시 (현재는 완료 후 print)
- `/zai:adversarial-review` — 비판적 리뷰 모드
- `--resume-last` — 이전 대화 이어가기 (Z.AI 멀티턴 컨텍스트 저장)
- 멀티 프로필 (개인/회사 토큰 분리)
- 비용 누적 표시 (응답 헤더 / token usage)
- Stop 훅 기반 자동 리뷰 게이트

## 6. 비목표 (MVP)

- ❌ Z.AI 를 Claude Code 의 *기본 모델*로 교체 (그건 별도 설정 영역)
- ❌ Vision / 이미지 입력
- ❌ Tool use / function calling 위임
- ❌ Z.AI 에서 다시 Claude 호출하는 양방향 루프
- ❌ 자체 UI / 웹 대시보드

## 7. 보안 / 프라이버시

- API 키는 `~/.config/zai-plugin-cc/config.json` (mode 0600) 에 저장. 저장소에 커밋되지 않도록 `.gitignore` 가이드
- 환경 변수 `ZAI_API_KEY` 로 오버라이드 가능 (CI/CD 시나리오)
- 사용자 코드는 명시적으로 위임된 부분만 Z.AI 로 전송 — 자동 컨텍스트 업로드 없음
- Z.AI 응답은 stdout 으로만 흐름 — 디스크 캐시는 job 결과만 (`.zai/jobs/`)

## 8. 의존성

- **런타임**: Node.js 18+ (Claude Code 와 동일 요구사항)
- **외부 패키지**: 없음 (순수 fetch + node:fs/node:crypto)
- **선택**: `tiktoken` 같은 토크나이저는 사용 안 함 — Z.AI 가 토큰 카운트 알려줌
