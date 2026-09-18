# 배포 및 재시작

## 배치

- Railway: Spring Boot WAS + 바닐라 웹 화면 + PostgreSQL, 서버 1개 인스턴스.
- Daytona Personal: `subway-alert-detector`, `subway-alert-verifier`, 각 Python 3.12 / 1 vCPU / RAM 1 GiB / disk 3 GiB.
- 로컬: 개발용 Spring + H2 파일 DB. 외부 콜백이나 포트포워딩 없이 서버가 에이전트의 private preview로 요청합니다.

2026-09-18 실제 Daytona 샌드박스에서 서울시 샘플 API에 접근했으나 `403 Internet is restricted on Tier 1 and Tier 2`를 받았습니다. Spring/DB 자체 실행은 가능해도 이 계정의 외부 API 제한 때문에 WAS는 Railway로 배치합니다. [Daytona 네트워크 제한](https://www.daytona.io/docs/en/network-limits/).

## 1. 에이전트 배포

Python 3.11 이상. `.env`에 `DAYTONA_API_KEY`, `OPENAI_API_KEY`, `TMAP_APP_KEY`를 넣습니다. 보조 관측을 쓰려면 `SEOUL_API_KEY`도 넣은 뒤:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r scripts/requirements.txt
.\.venv\Scripts\python.exe scripts/deploy_daytona.py --hours 24
```

macOS/Linux는 `.venv/bin/python`을 사용합니다. 스크립트가 기존의 같은 이름 샌드박스를 재사용하고, 파일 업로드 → 비밀 설정 → 실행 → 외부 health 확인 → Railway 변수 파일 생성을 수행합니다. 재실행은 해당 서비스의 기존 프로세스를 정상 종료한 뒤 교체합니다.

배포 결과는 `.deploy/daytona.json`, 서버용 설정은 `.deploy/railway.env`에 저장됩니다. `.env`, `.deploy`, `data`, `logs`, `.venv`는 Git에서 제외합니다. `.deploy/railway.env` 내용을 Railway `subway-alert` 서비스의 Variables에 넣습니다.

실제 API 키는 worker의 private `runtime.json`에 저장합니다. Daytona API 키 자체는 에이전트에 전달하지 않습니다. 기본 worker HTTP port는 8000, 요청에는 `Authorization: Bearer AGENT_TOKEN`과 서버만 가진 Daytona preview token이 필요합니다. public preview는 사용하지 않습니다.

기본 배포는 작업 프로세스를 24시간 실행하고, Daytona API 활동이 24시간 없으면 샌드박스를 자동 정지하도록 설정합니다. 영구 삭제는 하지 않습니다. 시연 전에 스크립트를 다시 실행하고 `/health`를 확인하세요. 명시적 종료:

```powershell
.\.venv\Scripts\python.exe scripts/deploy_daytona.py --stop
```

## 2. Railway

1. GitHub `moongongpyo/subway-alert`를 서비스 소스로 지정합니다. `Dockerfile`은 자동 감지합니다. 2026-08-28 이후 신규 서비스는 기존 Config-as-Code 방식에 가입할 수 없으므로 `railway.toml`은 참고값입니다. Settings에서 Healthcheck `/actuator/health`, On Failure 재시작 3회, Replica 1을 직접 설정합니다. [공식 안내](https://docs.railway.com/config-as-code).
2. 같은 프로젝트에 PostgreSQL 서비스 이름 `Postgres`를 생성합니다.
3. Spring 서비스 Variables에 다음을 추가합니다. **문자 그대로 Railway 변수 참조를 사용합니다.**

```dotenv
JDBC_DATABASE_URL=jdbc:postgresql://${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}
DB_USERNAME=${{Postgres.PGUSER}}
DB_PASSWORD=${{Postgres.PGPASSWORD}}
APP_MODE=DEMO
```

4. `.deploy/railway.env`의 값들을 함께 추가합니다. OpenAI 키는 WAS에 필요 없습니다.
5. Deploy 후 `/actuator/health`가 UP인지 확인하고 Settings → Networking에서 도메인을 생성합니다.
6. 앱의 `연결 및 시연`에서 토큰 없이 DEMO 흐름을 검증합니다. 운영 제어는 공개이며 서버 전체에 적용됩니다. 위치·도착 키가 연결된 경우에만 해당 관측을 LIVE로 전환할 수 있습니다. 공식 공지는 이 모드와 독립적으로 수집합니다.

`PORT`는 Railway가 제공합니다. PostgreSQL은 내부 호스트로 연결합니다. H2를 Railway 임시 파일시스템에 두면 재배포 시 데이터가 없어지므로 PostgreSQL 연결 후 운영합니다. H2를 별도로 쓰려면 영속 볼륨을 붙여 `JDBC_DATABASE_URL=jdbc:h2:file:/data/subway`를 명시해야 합니다.

## 운영 범위와 제한

- 핵심 경로: TMAP 일일 예산 기본 10건. 사용자 검색에만 호출, 같은 좌표/이름 5분 메모리 캐시, 최대 10개 후보. 회피 변경은 TMAP을 추가 호출하지 않습니다. [공식 경로 API](https://transit.tmapmobility.com/docs/routes), [이용약관](https://transit.tmapmobility.com/terms).
- 경로 세션도 5분 후 만료하며 재배포 시 사라집니다. 사용자별 검색은 5분에 최대 10개, 서버 전체 최대 200개. PostgreSQL에는 TMAP 응답을 저장하지 않습니다.
- 경로 AI: 검색/회피 변경 때 A→B. 수정은 최대 1회, 역할별 50초/내부 42초 제한. 비동기 상태 조회로 진행 상황 표시. AI 미연결은 서버 규칙 검사라고 표시하고, 연결된 AI 검증에 실패하면 추천을 보류합니다.
- 기본 2분 간격, 수집 1회 위치 1건 + 역별 도착 3건, 일일 상한 900건. 재시도·추가 조회도 예산을 차감합니다. 24시간 상시 수집 예산이 아니며, 재조회 제외 약 7.5시간에 해당합니다. 할당량을 확인하고 시연/출퇴근 시간에 LIVE를 사용하세요.
- 보조 관측 LLM은 지연 후보가 발견될 때만 호출. 탐지 → 검증 → 최대 2회 재조회. 에이전트 작업 제한 50초, worker 내부 LLM 도구 루프 42초/5회. 초과하면 보류.
- 웹 알림은 DB에 저장합니다. 브라우저 알림은 사용자가 허용하고 페이지를 열어 둔 동안만 표시합니다. SMS/메일/Web Push 백그라운드 전송은 이번 MVP 범위 밖입니다.
- 익명 구독은 브라우저 HttpOnly 쿠키 기준입니다. 사용자 계정/다기기 동기화는 없습니다.
- 서버 1개 replica 기준의 작업 직렬화와 SQL 원자적 사용량/알림 중복 방지. 여러 replica 운영 전에는 분산 작업 잠금과 외부 큐가 필요합니다.
- 관측·메시지·작업은 7일 후 정리합니다. 사건·구독·알림은 유지합니다. 서비스 재시작 시 미완료 작업은 INTERRUPTED로 표시하며 자동 발송하지 않습니다.
- 두 API는 같은 원천입니다. AI 두 개의 동의가 독립된 공신력 있는 장애 확인은 아닙니다. 원인/복구 시각을 생성하지 않습니다.
- 모드 변경은 현재 서버 프로세스에 적용합니다. 재시작 기본 모드는 `APP_MODE` 환경 변수입니다.

## 발표 리허설

주 시연은 [PLAN.md의 경로 시연](PLAN.md#해커톤-시연)을 따릅니다. 아래는 보조 지연 알림 시연입니다.

1. `역삼 / 내선` 구독 → 연결 및 시연에서 같은 구간 선택.
2. `지연 징후` → 활동 화면의 read_observations / check_freshness / REQUEST_REFRESH 확인.
3. 내 알림에 `[시연] … 지연 의심` 1건. 같은 상황 다시 실행해도 같은 사건 단계의 알림 수는 증가하지 않음.
4. `오래된 데이터`, `수집 실패`, `타임아웃`, `잘못된 응답` → 새 지연 알림 없음.
5. `관측 회복` → 위치 이동/ETA 감소 및 별도 회복 안내. 공식 운행 복구 확정과 구분.

검증 명령: `./gradlew test bootJar`, `python -m unittest discover -s agents -v`, `python scripts/smoke_workers.py`, 두 JS 파일에 `node --check`.
