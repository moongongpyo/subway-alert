# 구현·배포 상태

2026-09-18 기준. 키가 없는 상태의 구현 완료와 실제 외부 API 연결을 구분합니다.

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
- 키 대기 중 샌드박스 정지를 요청했습니다. 배포 스크립트가 기존 이름을 찾아 재시작하며 중복 생성하지 않습니다.

## 검증된 코드

- Java 테스트 17개, Python 테스트 12개 통과.
- 실제 별도 프로세스 3개(Spring/A/B)의 HTTP 통신: 경로 계획/검증/지하철·버스 회피/대안 소진 및 보조 관측 재조회/알림 테스트 통과.
- 에이전트 B의 수정 요청에 따른 A 재실행, 두 에이전트가 잘못된 경로에 동의해도 서버가 차단하는 테스트 포함.
- TMAP 모의 HTTP 서버로 요청 헤더/좌표/10개 후보 요청, 응답 파싱, 통과 정류장, 캐시, 일일 예산 검사.
- 실제 브라우저에서 검색 → 지하철 회피 → 버스 A 회피 → 버스 B → 대안 없음 → 회피 해제 흐름 확인.
- 데스크톱/모바일 화면 확인. JS 문법 검사 및 브라우저 콘솔 오류 없음.

## 키 연결 후 남은 단계

1. [KEYS.md](KEYS.md)의 TMAP / OpenAI / Daytona 키를 Git에서 제외된 `.env`에 입력. 서울시 관측도 연결하려면 서울시 키 추가.
2. `scripts/deploy_daytona.py`로 두 샌드박스에 worker 업로드/실행 및 private preview 연결 정보 생성.
3. `.deploy/railway.env`를 WAS 환경 변수에 반영하고 재배포.
4. 실제 TMAP 응답과 실제 OpenAI 도구 호출, Daytona 외부 통신을 검증.

**현재 Daytona에 worker가 배포되어 WAS와 연결된 상태는 아닙니다.** 샌드박스 리소스와 배포 코드는 준비되었으며 API 키가 필요합니다. 실제 TMAP/OpenAI 요청 성공은 아직 검증하지 않았습니다. 키 없는 공개 앱은 합성 경로와 서버 규칙 검사로 동작합니다.
