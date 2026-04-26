# zai-plugin-cc — MVP 사양

> "최소한 이것까지 동작해야 v0.1 로 부른다" 의 정의.

## 1. MVP 한 줄 정의

> Claude Code 안에서 `/zai:setup` 으로 토큰을 한 번 등록하고, 그 뒤로 `/zai:ask`, `/zai:code`, `/zai:review`, `/zai:consult` 네 개의 명령으로 GLM-4.6 / GLM-4.5-Air 에 작업을 위임할 수 있다.

## 2. 사용자 여정 (golden path)

### 2.1 첫 사용

```text
사용자  : /zai:setup
플러그인 : "Z.AI API 키를 입력하세요. (https://z.ai/model-api 에서 발급)"
사용자  : sk-zai-xxxxxxxxxx
플러그인 : "검증 중..." → GET /api/paas/v4/models 호출
플러그인 : "✓ 등록됨. 사용 가능 모델: glm-4.6, glm-4.5-air, ..."
            (~/.config/zai-plugin-cc/config.json 에 0600 으로 저장)
```

### 2.2 단발 질문

```text
사용자  : /zai:ask 이 정규식이 왜 ReDoS 위험한지 알려줘: ^(a+)+$
플러그인 : (포그라운드, glm-4.5-air)
GLM    : "백트래킹 폭주가 일어나는 이유는..."
플러그인 : GLM 응답을 그대로 출력
```

### 2.3 큰 위임

```text
사용자  : /zai:code 이 모듈 src/auth/ 를 읽고 JWT 만료 처리 추가해서 패치 줘
플러그인 : 작업 크기 추정 → "백그라운드 권장" → AskUserQuestion
사용자  : "백그라운드"
플러그인 : detached 프로세스 실행, job-id 반환
사용자  : /zai:status
플러그인 : 진행 중 job 표
사용자  : /zai:result <job-id>
플러그인 : 최종 답변(코드 패치) 출력
```

### 2.4 리뷰

```text
사용자  : /zai:review
플러그인 : git diff (working tree) 추출 → glm-4.6 에 리뷰 요청 →
            "버그 X / 보안 Y / 스타일 Z" 출력
```

### 2.5 상담

```text
사용자  : /zai:consult 이 시스템에 큐를 넣을지 SSE 로 끝낼지 봐줘
플러그인 : 백그라운드 시작 (긴 응답 예상) → job-id 반환
```

## 3. 명령어 사양

| 슬래시 | 인자 | 모드 | 기본 모델 | 결과 |
|--------|------|------|-----------|------|
| `/zai:setup` | `[--reset]` | 동기 | — | 토큰 저장 + 헬스체크 |
| `/zai:ask` | `<message...>` | 포그라운드 | `glm-4.5-air` | GLM 응답 |
| `/zai:code` | `[--wait\|--background] [--model <m>] <task...>` | 자동 추정 | `glm-4.6` | job-id 또는 응답 |
| `/zai:review` | `[--wait\|--background] [--base <ref>]` | 자동 추정 | `glm-4.6` | job-id 또는 응답 |
| `/zai:consult` | `[--wait\|--background] <topic...>` | 백그라운드 권장 | `glm-4.6` | job-id 또는 응답 |
| `/zai:status` | `[job-id]` | 동기 | — | job 표 또는 상세 |
| `/zai:result` | `<job-id>` | 동기 | — | 저장된 최종 응답 |
| `/zai:cancel` | `<job-id>` | 동기 | — | 종료 신호 |

### 3.1 자동 추정 규칙 (review/code/consult)

- 명시적 `--wait` / `--background` 가 있으면 그대로 따른다
- 없으면 입력 추정:
  - `code` / `review`: working-tree 변경이 1~2 파일 수준이면 `Wait` 추천, 그 외 `Background` 추천
  - `consult`: 항상 `Background` 추천 (긴 응답)
- `AskUserQuestion` 한 번 띄워 사용자가 결정

## 4. 데이터 / 상태 모델

```jsonc
// .zai/jobs/<job-id>.json   — repo-local
{
  "id": "01HZ...ULID",
  "kind": "code|review|consult|ask",
  "status": "running|done|error|cancelled",
  "model": "glm-4.6",
  "created_at": "2026-04-26T12:34:56Z",
  "started_at": "...",
  "ended_at": "...",
  "request": { /* 원본 요청 */ },
  "result": "최종 텍스트 (status=done 일 때)",
  "error":  "에러 메시지 (status=error 일 때)",
  "pid": 12345
}
```

```jsonc
// ~/.config/zai-plugin-cc/config.json   — 사용자 전역, 0600
{
  "version": 1,
  "api_key": "sk-zai-...",
  "base_url": "https://api.z.ai/api/paas/v4",
  "default_model": "glm-4.6",
  "light_model":   "glm-4.5-air",
  "timeout_ms": 300000
}
```

## 5. 비목표 (MVP 단계)

- ❌ 스트리밍 SSE 표시 (완료 후 일괄 출력으로 충분)
- ❌ Vision / 멀티모달
- ❌ Tool use 위임
- ❌ Stop 훅 자동 리뷰 게이트
- ❌ 멀티 프로필
- ❌ Z.AI 를 Claude Code 의 기본 모델로 사용 (별개의 설정)

## 6. 성공 기준 (DoD)

- [ ] `npm` 의존성 0 으로 동작 (Node 18+ 표준 모듈만)
- [ ] `/zai:setup` 후 `/zai:ask "hi"` 가 GLM 응답을 그대로 반환
- [ ] `/zai:code` 백그라운드 → `/zai:status` → `/zai:result` 사이클 완주
- [ ] 토큰 누락/만료 시 메인 Claude 세션 안 망가뜨리고 친절한 에러 1줄
- [ ] `.zai/jobs/` 외부에 잔여 상태 0
- [ ] `agents/zai-consultant.md` 가 직접 코드 작성하지 않고 단일 Bash 호출만
- [ ] Codex 플러그인과 충돌 없음 (네임스페이스 분리)

## 7. 위험 요소

| 위험 | 완화 |
|------|------|
| Z.AI API 모델명 변경 | config 의 `default_model` 로 외부화, README 갱신 |
| 응답 지연/타임아웃 | 백그라운드 모드 + `timeout_ms` 가드 |
| 토큰 유출 | 0600 권한 + `.gitignore` + 메모리 내에서만 노출 |
| job 누적 | `.zai/jobs/` 14 일 이상 항목 자동 청소 (런타임 진입 시) |
| 이중 호출 (rescue 와 동시) | job-id 별 디렉토리 분리 |
