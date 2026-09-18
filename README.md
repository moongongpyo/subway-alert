# 다음길

TMAP 대중교통 후보를 비교하고, 이용할 수 없는 구간을 제외해 대안을 찾는 서비스입니다.

## 구성

- Java 21 / Spring Boot: 웹 서버, 경로 검색, 공지 수집, OpenAI 도구 실행·계획·검증을 하나의 프로세스에서 처리
- 바닐라 HTML / CSS / JavaScript: 검색 → 경로 상세 → 구간 회피
- Railway: Spring 서버 및 PostgreSQL
- OpenAI Responses API: 계획/검증 역할을 각각 호출. 도구는 Java 메서드로 실행하며 별도 Python 또는 Daytona 서버가 필요하지 않습니다.
- TMAP: 장소 이름 검색(POI)과 실제 후보 경로. 서울교통공사: 공식 운행 공지.

## 실행

Java 21에서 환경 변수를 설정하고 `./gradlew bootRun`을 실행합니다. `.env`는 Spring에서 자동으로 읽지 않습니다.

필수 연결: `TMAP_APP_KEY`, `OPENAI_API_KEY`. 공지: `SEOUL_NOTICE_API_KEY`. 모델 기본값: `OPENAI_MODEL=gpt-4.1-mini`.
로컬 DB 기본값은 H2이며, 배포 시 `JDBC_DATABASE_URL`, `DB_USERNAME`, `DB_PASSWORD`로 PostgreSQL을 연결합니다.

`./gradlew test`로 서버 규칙, OpenAI 도구 계약, 사용자별 경로 격리 등을 검증합니다.

## 동작 범위

TMAP이 반환한 후보 내에서 소요시간·환승·도보 순으로 추천합니다. 회피 시 캐시된 후보를 재검사하며 경로를 임의 생성하지 않습니다. 정보는 5분 후 만료됩니다. AI 오류 시 추천을 보류합니다. 공지의 종료 시각이 없으면 현재 장애로 단정하지 않습니다.

운영 대시보드, 설정, 시연 제어, 에이전트 로그는 사용자 화면에서 제거했습니다. 기존 관측·운영 API는 호환성을 위해 서버에 남아 있으며 사용자 승인에 따라 운영 API는 공개 상태입니다.

`agents/`, `scripts/deploy_daytona.py`, `scripts/sandbox_runner.py`, `scripts/smoke_workers.py`는 이전 샌드박스 구조의 참고 자료입니다. 현재 서비스 실행·배포에 사용하지 않습니다. Daytona 샌드박스는 삭제했으며 현재 실행에 필요하지 않습니다.

## 별도 장애 시연 페이지

`/mock.html`에서 장소 이름으로 경로를 불러온 뒤 지하철·버스 구간, 시작 시각(한국 시간), 지속 시간을 지정해 장애를 예약하거나 해제합니다. 실제 서울시 공지 목록과 **공지 즉시 수집** 버튼도 이 페이지에서 제공합니다. 수집 요청은 서버 전체에서 15초 간격으로 제한됩니다.

메인 `/`에는 장소 검색과 경로 안내만 둡니다. 좌표는 검색 결과에서 내부적으로 사용합니다. 목업은 **장애 시연으로 열기**로 진입한 `/?simulation=1` 검색에만 적용되며 일반 검색에는 영향을 주지 않습니다. 예시 경로는 시연 페이지에서만 선택할 수 있습니다. 열린 시연 검색은 장애 시작·종료·해제를 주기적으로 반영하며, 경로 자체가 5분 후 만료되면 다시 검색해야 합니다.

팀원 실행·DB 초기화·키 공유 방법: [docs/TEAM_SETUP.md](docs/TEAM_SETUP.md). 실제 키가 든 `.env.team`은 Git에 포함되지 않습니다.
