# zai-plugin-cc — 아키텍처

## 1. 컴포넌트 다이어그램 (텍스트)

```
┌────────────────────────────────────────────────────────────────┐
│                      Claude Code (메인 세션)                      │
│                                                                │
│   사용자 입력  ──▶ 슬래시 커맨드 (/zai:ask, /zai:code, ...)        │
│                       │                                        │
│                       ├─ 일부는 직접 Bash 로 companion 호출       │
│                       │                                        │
│                       └─▶ Agent(zai-consultant)                │
│                              ▲                                 │
│                              │ 얇은 포워더 (한 번의 Bash 만)        │
└──────────────────────────────┼─────────────────────────────────┘
                               │
                               ▼
       ┌────────────────────────────────────────────┐
       │   scripts/zai-companion.mjs (하네스 런타임)   │
       │                                            │
       │   ┌────────────┐ ┌────────────┐            │
       │   │ config 로더 │ │ job 매니저  │            │
       │   └────────────┘ └────────────┘            │
       │   ┌──────────────────────────────────┐     │
       │   │ Z.AI 클라이언트 (fetch 기반)        │     │
       │   └──────────────────────────────────┘     │
       └─────────────┬──────────────────────────────┘
                     │
                     ▼
            ┌──────────────────────┐
            │  api.z.ai (GLM 모델)  │
            └──────────────────────┘
```

## 2. 디렉토리 레이아웃

```text
zai-plugin-cc/
├── README.md
├── docs/
│   ├── FEATURES.md
│   ├── MVP.md
│   └── ARCHITECTURE.md
├── .claude-plugin/
│   └── plugin.json                    # 플러그인 매니페스트
├── agents/
│   └── zai-consultant.md              # 하네스 에이전트 (얇은 포워더)
├── commands/
│   ├── setup.md                       # 토큰 등록 + 헬스체크
│   ├── ask.md                         # 포그라운드 단발
│   ├── code.md                        # 코드 위임 (자동 추정)
│   ├── review.md                      # git diff 리뷰
│   ├── consult.md                     # 설계 상담
│   ├── status.md                      # job 상태
│   ├── result.md                      # 결과 조회
│   └── cancel.md                      # 취소
├── skills/
│   ├── zai-cli-runtime/SKILL.md       # 내부 호출 계약 (서브에이전트 전용)
│   └── zai-prompting/SKILL.md         # GLM 프롬프트 작성 가이드
├── scripts/
│   ├── zai-companion.mjs              # 진입점, 서브커맨드 디스패처
│   └── lib/
│       ├── config.mjs                 # 토큰/설정 로드/저장
│       ├── client.mjs                 # Z.AI fetch 래퍼
│       ├── jobs.mjs                   # .zai/jobs CRUD + ULID 발급
│       ├── runner.mjs                 # foreground/background 실행기
│       └── prompts.mjs                # 명령별 프롬프트 템플릿
├── hooks/                             # MVP 에선 비어 있음 (확장 슬롯)
└── .gitignore
```

## 3. 데이터 흐름 (시퀀스)

### 3.1 `/zai:ask "hi"` (포그라운드)

```text
User ──▶ /zai:ask "hi"
     ▼
commands/ask.md  →  Bash:
  node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" ask "hi"
     ▼
zai-companion.mjs
  ├─ config.load()                — ~/.config/zai-plugin-cc/config.json 읽기
  ├─ client.chat({ model: glm-4.5-air, messages: [...]})
  │     └─▶ POST https://api.z.ai/api/paas/v4/chat/completions
  └─ stdout 으로 응답 텍스트 출력
     ▼
Claude 메인이 stdout 을 그대로 사용자에게 반환
```

### 3.2 `/zai:code "..."` (백그라운드)

```text
User ──▶ /zai:code --background "<task>"
     ▼
commands/code.md  →  Agent(zai-consultant, prompt=raw input)
     ▼
agents/zai-consultant.md  →  단일 Bash:
  node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" code --background "<task>"
     ▼
zai-companion.mjs
  ├─ jobs.create(kind=code, ...)  → .zai/jobs/<id>.json (status=running, pid=...)
  ├─ detach: spawn 자식 프로세스로 실행 본체 재호출
  ├─ stdout: "job-id: <id> (background)"
  └─ exit 0
   (자식 프로세스가 별도로 client.chat → jobs.update(status=done, result=...) 까지 수행)
     ▼
사용자 차후:
  /zai:status        → jobs.list() 표
  /zai:result <id>   → jobs.get(id).result 출력
```

## 4. 모듈 인터페이스 (계약)

### 4.1 `lib/config.mjs`

```js
export async function load()       // → { api_key, base_url, default_model, ... }
export async function save(cfg)    // 0600 으로 ~/.config/zai-plugin-cc/config.json 작성
export async function reset()      // 파일 제거
export function fromEnv()          // ZAI_API_KEY 등 env 우선
```

### 4.2 `lib/client.mjs`

```js
export async function chat({ apiKey, baseUrl, model, messages, temperature, signal })
  // → { text, usage, raw }
export async function listModels({ apiKey, baseUrl })
  // → string[]
```

- 순수 `fetch` 사용
- 4xx / 5xx 는 `ZaiApiError` 클래스로 통합
- `AbortSignal` 지원 (cancel 용)

### 4.3 `lib/jobs.mjs`

```js
export function create({ kind, request, model })  // → jobRecord
export function get(id)                            // → jobRecord | null
export function list({ activeOnly })               // → jobRecord[]
export function update(id, patch)                  // 부분 업데이트 (atomic write)
export function cancel(id)                         // pid 에 SIGTERM
export function gcOlderThanDays(n)                 // 14일 룰
```

저장 위치: `<repo-root>/.zai/jobs/<id>.json` — repo 단위로 격리. repo 가 아니면 `~/.zai/jobs/`.

### 4.4 `lib/runner.mjs`

```js
export async function runForeground({ kind, prompt, model, ... })
export async function runBackground({ kind, prompt, model, ... })   // → jobId
```

백그라운드는 `child_process.spawn(process.execPath, [scriptPath, '__worker', jobId], { detached: true, stdio: 'ignore' })` 로 분리.

### 4.5 `lib/prompts.mjs`

명령별 system + user 프롬프트 템플릿:

- `ask`     — 짧고 정확. 코드 변경 X.
- `code`    — 패치 / 함수 단위 코드 출력. 단계적 사고 후 최종 코드.
- `review`  — git diff 입력. 결함 / 보안 / 스타일 분리 출력.
- `consult` — 설계 토론. 트레이드오프 명시 요구.

## 5. 보안 모델

| 자산 | 위협 | 완화 |
|------|------|------|
| API 키 | 디스크 유출 | `~/.config/zai-plugin-cc/config.json` 0600, `.gitignore` |
| API 키 | env 로그 유출 | child_process 에 키만 별도 ENV 로 전달, stdout/err 에 절대 노출 X |
| 사용자 코드 | 무분별한 업로드 | 자동 첨부 X. review 만 `git diff` 일부를 명시 전송 |
| job 결과 | 잔존 PII | 14일 GC + 사용자가 `.zai/` 통째로 삭제 가능 |

## 6. 확장 포인트 (MVP 이후 슬롯)

- `hooks/hooks.json` — Stop 훅으로 "커밋 직전 자동 GLM 리뷰" 게이트
- `commands/adversarial-review.md` — 비판적 리뷰 변형
- `lib/streaming.mjs` — SSE 스트리밍 인 라이브 표시
- `commands/profile.md` — 멀티 프로필 (개인/회사 토큰)
- `lib/threads.mjs` — `--resume-last` 멀티턴

## 7. 관찰성 (MVP 수준)

- job 파일 자체가 단일 진실 소스 (`.zai/jobs/<id>.json`)
- 표준 출력은 사용자 응답 + 메타(`job-id: ..., model: ..., elapsed: ...`) 한 줄
- 환경변수 `ZAI_DEBUG=1` 이면 stderr 에 요청/응답 헤더 덤프
- 비용 / 토큰 사용량은 응답 `usage` 필드에서 받아 `jobRecord.usage` 에 적재
