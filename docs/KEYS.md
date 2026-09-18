# 키와 설정 — 마지막 연결 체크리스트

실제 키를 이 문서나 GitHub에 넣지 마세요. 프로젝트 루트 `.env` 또는 플랫폼 환경 변수에 저장합니다.

| 필요한 값 | 발급 위치 | 넣는 곳 / 설명 |
| --- | --- | --- |
| `SEOUL_API_KEY` | [서울 열린데이터광장 인증키 안내](https://data.seoul.go.kr/together/guide/useGuide.do) | Spring 서버. 실시간 지하철 API 사용이 가능한 키. 일반 공공데이터포털 키와 다름 |
| `OPENAI_API_KEY` | [OpenAI API Keys](https://platform.openai.com/api-keys) | Daytona의 탐지·검증 에이전트. 두 샌드박스에서 같은 프로젝트 키 사용 가능 |
| `DAYTONA_API_KEY` | [Daytona API Keys](https://app.daytona.io/dashboard/keys) | 로컬 배포 스크립트만 사용. 샌드박스를 만든 **Personal 조직**에서 발급 |

- OpenAI API는 [API 결제](https://platform.openai.com/settings/organization/billing/overview)가 별도입니다. ChatGPT 구독과 별개입니다. 기본 모델은 `gpt-4.1-mini`, `OPENAI_MODEL`로 바꿀 수 있습니다.
- 서울시 데이터: [실시간 도착정보](https://data.seoul.go.kr/dataList/OA-12764/A/1/datasetView.do), [열차 위치정보](https://data.seoul.go.kr/dataList/OA-12601/A/1/datasetView.do). 샘플 키는 제한된 대상 검증용이며 강남·역삼·선릉 운영 키를 대체하지 않습니다.
- `APP_ADMIN_TOKEN`, `AGENT_TOKEN`은 `python scripts/prepare_config.py`가 생성합니다. 발급받을 필요가 없습니다. `.deploy/secrets.json`에 저장되며 Git에서 제외됩니다.
- `DETECTOR_URL`, `VERIFIER_URL`, 두 `*_PREVIEW_TOKEN`은 `scripts/deploy_daytona.py`가 실제 샌드박스에서 조회해 `.deploy/railway.env`에 저장합니다. 사용자가 만들 필요가 없습니다.
- Daytona preview token은 샌드박스 접근 권한입니다. 브라우저 HTML/JS, 채팅, GitHub에 넣지 않습니다. Spring 서버에만 보관합니다.
- Railway의 PostgreSQL 비밀번호는 Railway가 생성합니다. 변수 참조로 서버에 전달하므로 별도 키가 필요하지 않습니다.

키가 없을 때도 로컬 DEMO는 실행됩니다. 이때 `simulation`은 규칙 기반 시뮬레이션입니다. 실제 OpenAI 호출로 소개하지 않습니다. LIVE는 서울시 키와 원격 에이전트 설정이 있어야 전환되며, 원격 에이전트에 OpenAI 키가 없으면 발송을 보류합니다.
