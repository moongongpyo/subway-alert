# 현재 구현 상태

2026-09-18. 현재 아키텍처는 Spring 모놀리식입니다.

- 경로 탐색만 남긴 단일 반응형 화면. 경로 상세와 공식 공지는 접어서 표시.
- 기본 실제 TMAP 경로 검색. 선택적으로 예시 경로 체험.
- 계획·검증 역할, OpenAI Responses 도구 호출, 관측 분석, 근거 검사를 모두 Java `AgentGateway`에서 실행.
- Daytona 주소/preview token/agent token은 Spring 런타임에서 읽지 않습니다.
- `OPENAI_API_KEY`와 `OPENAI_MODEL`을 Railway WAS에 설정. 기존 키의 발급 시 설정한 7일 만료는 유지됩니다.
- 기존 Python worker/배포 파일은 이전 구조 참고 자료이며 새 서비스의 의존성이 아닙니다.
- 위치·도착 관측은 별도 키가 필요하며 공식 공지와 다릅니다. 일반 사용자 화면에서는 운영 정보를 표시하지 않습니다.
- Java 테스트 22개: Spring 도구 실행 계약과 허구 경로 거부 테스트 포함.
