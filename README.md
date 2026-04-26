# zai-plugin-cc

> Claude Code 옆에 두는 **Z.AI (GLM-4.6 / GLM-4.5-Air)** 보조 두뇌 플러그인.
>
> Codex 플러그인의 위임 패턴을 차용해, GLM 에게 코드 생성·리뷰·설계 상담을 맡긴다.

## 빠른 시작

```bash
# 1. Claude Code 에서 마켓플레이스/로컬 경로로 플러그인 등록 후
/zai:setup        # Z.AI API 키 입력 (한 번만)

# 2. 사용
/zai:ask    이 함수가 왜 느린지 봐줘
/zai:code   <task>      # 큰 작업 위임
/zai:review             # git diff 리뷰
/zai:consult <topic>    # 설계 상담
/zai:status             # 진행 중 job 보기
/zai:result <id>        # 결과 다시 보기
/zai:cancel <id>        # 취소
```

## 문서

- [`docs/FEATURES.md`](docs/FEATURES.md) — 기능 분석
- [`docs/MVP.md`](docs/MVP.md) — MVP 범위와 사양
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — 아키텍처 / 데이터 흐름

## 라이선스

MIT (예정)
