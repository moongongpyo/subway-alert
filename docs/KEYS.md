# 키와 설정 — 마지막 연결 체크리스트

실제 키를 이 문서나 GitHub에 넣지 마세요. 프로젝트 루트 `.env` 또는 플랫폼 환경 변수에 저장합니다.

| 필요한 값 | 발급 위치 | 넣는 곳 / 설명 |
| --- | --- | --- |
| `TMAP_APP_KEY` | [TMAP 대중교통 API 이용절차](https://transit.tmapmobility.com/guide/procedure) | Spring 서버. SK Open API 앱 키 + **대중교통 경로탐색 상품** 이용권한 |
| `SEOUL_API_KEY` (보조 관측용) | [서울 열린데이터광장 인증키 안내](https://data.seoul.go.kr/together/guide/useGuide.do) | Spring 서버. 실시간 지하철 API 사용이 가능한 키. 경로 안내만 쓸 때는 필요 없음 |
| `OPENAI_API_KEY` | [OpenAI API Keys](https://platform.openai.com/api-keys) | Daytona의 탐지·검증 에이전트. 두 샌드박스에서 같은 프로젝트 키 사용 가능 |
| `DAYTONA_API_KEY` | [Daytona API Keys](https://app.daytona.io/dashboard/keys) | 로컬 배포 스크립트만 사용. 샌드박스를 만든 **Personal 조직**에서 발급 |

2026-09-18 현재 OpenAI / Daytona 키 발급과 실제 AI 연결은 완료했습니다. 추가로 필요한 필수 키는 `TMAP_APP_KEY`이며, 서울시 보조 관측을 사용할 때만 `SEOUL_API_KEY`도 준비합니다. OpenAI 키는 발급 시 7일 만료로 설정했으므로 만료 후 교체해야 합니다.

TMAP은 [이용약관](https://transit.tmapmobility.com/terms)의 무료 경로탐색 10회/일 기준으로 `TMAP_DAILY_BUDGET=10`을 기본 설정했습니다. 실제 발급 상품의 할당량을 확인하세요. 자동 주기 조회 없이 사용자 검색 때만 호출하며 회피 조건 변경은 캐시된 후보를 사용합니다.

- OpenAI API는 [API 결제](https://platform.openai.com/settings/organization/billing/overview)가 별도입니다. ChatGPT 구독과 별개입니다. 기본 모델은 `gpt-4.1-mini`, `OPENAI_MODEL`로 바꿀 수 있습니다.
- 서울시 데이터: [실시간 도착정보](https://data.seoul.go.kr/dataList/OA-12764/A/1/datasetView.do), [열차 위치정보](https://data.seoul.go.kr/dataList/OA-12601/A/1/datasetView.do). 샘플 키는 제한된 대상 검증용이며 강남·역삼·선릉 운영 키를 대체하지 않습니다.
- `APP_ADMIN_TOKEN`, `AGENT_TOKEN`은 `python scripts/prepare_config.py`가 생성합니다. 발급받을 필요가 없습니다. `.deploy/secrets.json`에 저장되며 Git에서 제외됩니다.
- `DETECTOR_URL`, `VERIFIER_URL`, 두 `*_PREVIEW_TOKEN`은 `scripts/deploy_daytona.py`가 실제 샌드박스에서 조회해 `.deploy/railway.env`에 저장합니다. 사용자가 만들 필요가 없습니다.
- Daytona preview token은 샌드박스 접근 권한입니다. 브라우저 HTML/JS, 채팅, GitHub에 넣지 않습니다. Spring 서버에만 보관합니다.
- Railway의 PostgreSQL 비밀번호는 Railway가 생성합니다. 변수 참조로 서버에 전달하므로 별도 키가 필요하지 않습니다.

키가 없을 때도 로컬 DEMO는 실행됩니다. 이때 `simulation`은 규칙 기반 시뮬레이션입니다. 실제 OpenAI 호출로 소개하지 않습니다. LIVE는 서울시 키와 원격 에이전트 설정이 있어야 전환되며, 원격 에이전트에 OpenAI 키가 없으면 발송을 보류합니다.

## 서울교통공사 공식 공지

`SEOUL_NOTICE_API_KEY`는 서울 열린데이터광장의 `getNtceList` 인증키입니다. 2026-09-18 사용자 제공 키로 `00 / NORMAL_CODE`와 1,000건 응답을 확인했습니다. 키는 로컬 `.env`와 Railway 서버 변수에만 보관합니다. `dtn_` Daytona 키를 넣으면 수집하지 않습니다.

- 출처: https://data.seoul.go.kr/dataList/OA-22718/A/1/datasetView.do
- 서버 API: `/api/metro-notices`. 2분 간격, 일 800회 예산. 사용자 화면 조회는 캐시만 읽습니다.
- `SEOUL_NOTICE_API_KEY`가 없으면 `SEOUL_API_KEY`를 사용합니다. 열차 위치·도착 API와 공지 API는 별도 엔드포인트이며, 이번에 연결한 것은 공지 API입니다.
- 한 번에 최대 1,000건 수집, 발표 시각순 최신 100건 반환, 화면 20건 표시. 전체 수집이 아니면 부분 목록임을 표시합니다.
- 공지 기간 경과/예정/기간 내/현재 상태 미확인을 구분합니다. 종료 시각 없는 과거 공지나 운행 재개 문구를 현재 장애로 자동 확정하지 않습니다.
- 공식 공지 원문을 보고 사용자가 버스·지하철 구간 회피를 선택합니다. 공지에서 경로로 자동 매칭하는 기능이나 버스 장애 공지 수집은 포함하지 않습니다.
