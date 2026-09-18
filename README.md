# 출근지킴이 · Subway Alert

버스·지하철의 이용 불가 구간을 피하는 **대안 경로 안내** 해커톤 MVP입니다. TMAP 후보를 경로 계획 A와 독립 검증 B가 검사하고, 서울시 열차 관측/알림을 보조 기능으로 제공합니다.

[배포된 앱](https://subway-alert-production.up.railway.app) · [배포 상태와 남은 연결](docs/STATUS.md)

**Java 21 · Spring Boot 4.1.1 · HTML/CSS/바닐라 JavaScript · H2/PostgreSQL · Daytona Python agents**

## 구현된 기능

- TMAP 경로 검색, 구간별 버스·지하철·도보 안내, 예상 시간/환승/요금 비교
- 승차 구간 또는 노선 전체 회피, 겹치는 후보 제외, 추가 소요시간, 대안 없음 처리
- 경로 계획 A → 독립 검사 B → 필요 시 수정 요청 → 서버 최종 검사
- 5분 캐시/세션, TMAP 호출 예산, 타 사용자 경로 세션 격리
- 지하철 → 버스 A → 버스 B → 대안 없음의 키 없는 합성 시연
- 역·내선/외선 구독, 최근 열차 위치/도착 관측, 웹 알림과 브라우저 알림
- 생성 시각/열차 식별자 검증, 지연 의심 규칙, 일일 API 호출 예산
- 탐지 A → 검증 B → 추가 관측 요청 → 재검증 → 발송 게이트
- OpenAI Responses API 도구 호출, private Daytona preview 및 서비스 토큰 인증
- 오래된 데이터·수집 실패·타임아웃·잘못된 응답 시 발송 차단
- 사건 단계별 중복 알림 차단, 익명 사용자별 구독/알림 분리, 관리자 제어
- 지연 / 오래된 데이터 / 수집 실패 / 관측 회복 / 타임아웃 / 응답 오류 시연

## 로컬 실행

```powershell
.\scripts\dev.ps1 run
```

Java 21이 필요합니다. Windows 스크립트는 IntelliJ의 사용자 `.jdks`에서도 JDK 21을 찾습니다. 다른 OS는 `./gradlew bootRun`을 사용합니다.

- 화면: http://localhost:8080
- 상태: http://localhost:8080/actuator/health
- 기본 모드: DEMO. 키 없이 규칙 기반 합성 데이터 시연 가능.
- 로컬 DB: `data/subway.mv.db`. 서버를 종료한 뒤 파일을 백업합니다.
- 로컬 직접 접속에서는 관리자 토큰 없이 시연할 수 있습니다. 외부 배포는 `APP_ADMIN_TOKEN`이 필요합니다.
- `.env`는 Python 배포 스크립트가 읽습니다. Spring은 OS 환경 변수 또는 `--KEY=value` Spring 설정으로 주입합니다.

## 클라우드 배치

Railway에 WAS + PostgreSQL, Daytona Personal에 탐지/검증 샌드박스 2개를 둡니다. 이 계정의 Daytona에서 서울시 API가 Tier 1/2 네트워크 제한으로 403을 반환하여 메인 서버는 Railway를 사용합니다. 포트포워딩은 필요 없습니다.

- [기획 및 구현 범위](docs/PLAN.md)
- [필요한 키와 발급 링크](docs/KEYS.md)
- [배포·재시작·시연 절차](docs/DEPLOY.md)

## 테스트

```powershell
.\scripts\dev.ps1 test
python -m unittest discover -s agents -v
node --check src/main/resources/static/app.js
node --check src/main/resources/static/routes.js
python scripts/smoke_workers.py
```

실제 HTTP를 통한 구독·시연·재조회·중복 방지·사용자 격리·오류 차단과 worker 도구 호출 프로토콜을 검증합니다. OpenAI 프로토콜 테스트는 모의 응답을 사용하므로 실제 유료 API 연결 성공을 의미하지 않습니다.

## 주의할 표현

경로 회피 조건은 내 검색에만 적용되며 공식 장애 제보가 아닙니다. TMAP이 반환한 후보에서만 대안을 비교합니다. 시간표/예상 시간은 실제 운행 보장이 아닙니다. 서울시 관측은 **지연 의심**이며 공식 장애 확정이 아닙니다. 키 미설정 상태를 실시간 운행 데이터나 실제 LLM 분석으로 표시하지 않습니다.
