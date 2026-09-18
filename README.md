# 다음길

TMAP 대중교통 후보를 비교하고, 이용할 수 없는 구간을 제외해 대안을 찾는 서비스입니다.

## 구성

- Java 21 / Spring Boot: 웹 서버, 경로 검색, 공지 수집, OpenAI 도구 실행·계획·검증을 하나의 프로세스에서 처리
- 바닐라 HTML / CSS / JavaScript: 검색 → 경로 상세 → 구간 회피
- Railway: Spring 서버 및 PostgreSQL
- OpenAI Responses API: 계획/검증 역할을 각각 호출. 도구는 Java 메서드로 실행하며 별도 Python 또는 Daytona 서버가 필요하지 않습니다.
- TMAP: 실제 후보 경로. 서울교통공사: 공식 운행 공지.

## 실행

Java 21에서 환경 변수를 설정하고 `./gradlew bootRun`을 실행합니다. `.env`는 Spring에서 자동으로 읽지 않습니다.

필수 연결: `TMAP_APP_KEY`, `OPENAI_API_KEY`. 공지: `SEOUL_NOTICE_API_KEY`. 모델 기본값: `OPENAI_MODEL=gpt-4.1-mini`.
로컬 DB 기본값은 H2이며, 배포 시 `JDBC_DATABASE_URL`, `DB_USERNAME`, `DB_PASSWORD`로 PostgreSQL을 연결합니다.

`./gradlew test`로 서버 규칙, OpenAI 도구 계약, 사용자별 경로 격리 등을 검증합니다.

## 동작 범위

TMAP이 반환한 후보 내에서 소요시간·환승·도보 순으로 추천합니다. 회피 시 캐시된 후보를 재검사하며 경로를 임의 생성하지 않습니다. 정보는 5분 후 만료됩니다. AI 오류 시 추천을 보류합니다. 공지의 종료 시각이 없으면 현재 장애로 단정하지 않습니다.

운영 대시보드, 설정, 시연 제어, 에이전트 로그는 사용자 화면에서 제거했습니다. 기존 관측·운영 API는 호환성을 위해 서버에 남아 있으며 사용자 승인에 따라 운영 API는 공개 상태입니다.

`agents/`, `scripts/deploy_daytona.py`, `scripts/sandbox_runner.py`, `scripts/smoke_workers.py`는 이전 샌드박스 구조의 참고 자료입니다. 현재 서비스 실행·배포에 사용하지 않습니다. Daytona는 추후 별도 기능을 위해 보류합니다.
