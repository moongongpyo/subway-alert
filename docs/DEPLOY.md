# Spring 모놀리식 배포

Railway `subway-alert`는 GitHub main 변경을 자동 배포합니다.

서버 환경 변수:
- `OPENAI_API_KEY`, `OPENAI_MODEL=gpt-4.1-mini`
- `TMAP_APP_KEY`, `TMAP_DAILY_BUDGET=10`
- `SEOUL_NOTICE_API_KEY`: 공식 공지
- `SEOUL_API_KEY`: 선택적인 위치·도착 관측
- `JDBC_DATABASE_URL`, `DB_USERNAME`, `DB_PASSWORD`: 기존 Railway PostgreSQL 참조

OpenAI 키는 Spring 서버에서만 사용합니다. Python worker, DETECTOR_URL, VERIFIER_URL, Daytona preview token은 필요하지 않습니다. `.env`는 로컬 비공개 참고 설정이며 Spring이 자동 로드하지 않습니다.

`./gradlew test bootJar` 후 `/actuator/health`, `/api/routes` 검색과 회피 흐름을 검증합니다. 에이전트 도구는 Spring 프로세스에서 실행되고 OpenAI API만 외부 호출합니다.

이전 샌드박스 배포 스크립트는 현재 배포에 실행하지 않습니다. 기존 샌드박스는 새 기능을 정할 때 재사용할 수 있습니다.
