# 팀원 실행 안내

공유할 파일: Git 프로젝트 전체와 별도로 `.env.team` 파일. 이 파일에는 실제 OpenAI/TMAP/서울시 공지 키가 들어 있으므로 팀원에게 비공개로 전달합니다. Git과 Docker 빌드에서는 제외됩니다. 운영 DB 비밀번호는 포함하지 않았습니다.

## Windows 실행

1. Java 21 설치 후 JAVA_HOME을 설정합니다.
2. 전달받은 `.env.team`을 프로젝트 루트에 둡니다.
3. 프로젝트 루트에서 `powershell -ExecutionPolicy Bypass -File scripts/start-local.ps1`을 실행합니다.
4. `http://localhost:8080/`에서 검색, `http://localhost:8080/mock.html`에서 시연 제어를 사용합니다.

기본 DB는 각 팀원의 `data/subway` H2 파일입니다. 별도 DB 설치가 필요 없으며 Spring이 `src/main/resources/schema.sql`을 자동 실행합니다. 일반 `gradlew bootRun`은 .env 파일을 자동으로 읽지 않으므로 제공한 스크립트를 사용하거나 IDE 환경 변수로 등록합니다.

## PostgreSQL

빈 DB를 생성한 뒤 `.env.team`의 JDBC_DATABASE_URL을 `jdbc:postgresql://localhost:5432/subway_alert`, DB_USERNAME/DB_PASSWORD를 해당 DB 계정으로 바꿉니다. Railway 내부 호스트는 로컬 PC에서 접속할 수 없습니다. 운영 DB를 팀원 개발용으로 공유하지 않습니다.

- `db/01-ddl.sql`: 현재 3개 테이블과 인덱스, Spring schema.sql과 동일.
- `db/02-dml.sql`: 선택적 일일 사용량 행 초기화. 기존 사용량을 초기화하지 않으며 반복 실행 가능.
- 별도 필수 마스터 데이터는 없습니다. 예시 경로는 Java에서 생성하고, 운행 공지는 API에서 수집합니다. 목업 장애는 시연 페이지에서 등록합니다.
- PostgreSQL 수동 초기화 예: `psql -d subway_alert -f db/01-ddl.sql`, `psql -d subway_alert -f db/02-dml.sql`. DML 실행 세션 시간대는 Asia/Seoul로 설정합니다.

## 필요한 키

- OPENAI_API_KEY: https://platform.openai.com/api-keys (현재 전달 키는 발급 당시 7일 만료로 설정)
- TMAP_APP_KEY: https://openapi.sk.com/ (대중교통 경로와 POI 장소 검색)
- SEOUL_NOTICE_API_KEY: https://data.seoul.go.kr/ (getNtceList 공식 공지)
- OPENAI_MODEL 기본값: gpt-4.1-mini

Daytona, AGENT_TOKEN, APP_ADMIN_TOKEN, DETECTOR/VERIFIER URL과 preview token은 필요 없습니다. SEOUL_API_KEY는 구형 위치·도착 관측 기능을 별도로 활성화할 때만 필요하며 현재 공지 키와 혼용하지 않습니다. 팀원이 같은 API 키를 쓰면 공급자 사용량도 공유됩니다.
