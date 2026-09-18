# 구현·배포 상태

2026-09-18 기준. 실제 AI 연결과 교통 데이터 연결 상태를 구분합니다.

## 준비된 리소스

- 앱: https://subway-alert-production.up.railway.app
- GitHub: https://github.com/moongongpyo/subway-alert
- 로컬: `C:\Users\bfloo\OneDrive\Desktop\subway-alert`
- Railway 프로젝트: `passionate-courtesy` / `b01b378a-edb4-4750-99e1-5b0a4118d1af`
- Railway `subway-alert` WAS + `Postgres` DB/영속 볼륨 생성, 내부 DB 연결 및 HTTPS 도메인 설정 완료.
- `APP_ADMIN_TOKEN` 생성 및 Railway 설정 완료. DB 비밀번호는 Railway 변수 참조로 전달.
- Daytona **Personal**의 private 샌드박스 2개 생성 완료:
  - `subway-alert-detector`: `8dbed64d-9e10-4bf2-ac4a-c0eca49fe1b7`
  - `subway-alert-verifier`: `74d9ed49-2df0-4509-8a02-55691fa067a2`
- 두 샌드박스에 OpenAI 기반 worker 배포 완료. private preview + 에이전트 토큰으로 Railway WAS와 연결했습니다.
- Daytona 대체 키 `subway-alert-deploy-retry`로 연결 성공 후 기존 `subway-alert-deploy` 키를 폐기했습니다.
- OpenAI `subway-alert-agents` 키는 Responses 실행 권한으로 발급했으며 발급 시 7일 만료를 설정했습니다.
- 현재 worker 실행 시간은 24시간으로 제한됩니다. 다음 시연 전에 필요하면 배포 스크립트를 재실행하세요.

## 검증된 코드

- Java 테스트 17개, Python 테스트 12개 통과.
- 실제 별도 프로세스 3개(Spring/A/B)의 HTTP 통신: 경로 계획/검증/지하철·버스 회피/대안 소진 및 보조 관측 재조회/알림 테스트 통과.
- 에이전트 B의 수정 요청에 따른 A 재실행, 두 에이전트가 잘못된 경로에 동의해도 서버가 차단하는 테스트 포함.
- TMAP 모의 HTTP 서버로 요청 헤더/좌표/10개 후보 요청, 응답 파싱, 통과 정류장, 캐시, 일일 예산 검사.
- 실제 브라우저에서 검색 → 지하철 회피 → 버스 A 회피 → 버스 B → 대안 없음 → 회피 해제 흐름 확인.
- 데스크톱/모바일 화면 확인. JS 문법 검사 및 브라우저 콘솔 오류 없음.

## 실제 클라우드 연결 검증

- Railway WAS → Daytona planner A → OpenAI → Daytona verifier B → OpenAI 전체 요청 성공.
- 합성 경로 최초 검색: `VERIFIED`, `route-1`; 지하철 구간 회피 후: `VERIFIED`, 버스 대안 `route-2`.
- 두 에이전트 모두 `engine=openai`, `read_routes` / `check_avoidance` 도구 실행, A `PROPOSE` → B `APPROVED` 확인.
- 인증정보는 Git에서 제외된 `.env`, `.deploy/` 및 해당 플랫폼의 서버 설정에만 저장했습니다.

## 남은 외부 데이터 연결

1. [KEYS.md](KEYS.md)의 `TMAP_APP_KEY`를 Railway WAS 환경 변수에 입력하고 재배포.
2. 실제 TMAP 응답으로 검색·회피 검증. 현재 경로 입력은 DEMO 합성 데이터이며 실제 교통 API 성공을 검증한 상태는 아닙니다.
3. 서울시 보조 관측까지 사용하려면 `SEOUL_API_KEY` 추가. 핵심 경로 안내에는 선택 사항입니다.

OpenAI / Daytona 키 발급 및 에이전트 연결은 완료되었습니다. 키가 만료되거나 샌드박스가 정지되면 재발급·재배포가 필요합니다.
