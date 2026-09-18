# Subway Alert · 출근지킴이

지하철 위치·도착 정보에서 지연 징후를 찾고, 두 AI 에이전트의 검증을 거쳐 관심 구간 사용자에게 알리는 해커톤 프로젝트입니다.

**현재 상태: Spring Boot 초기 프로젝트입니다.** 서버 기동과 헬스 체크를 제공하며, 서울시 API·Daytona·알림 기능은 아직 연결되지 않았습니다.

- [서비스 기획 및 구현 계획](docs/PLAN.md)
- 로컬 서버: Java 21 / Spring Boot 4.1.1 / Gradle Wrapper
- 기본 의존성: Spring Web MVC, Validation, Actuator
- AI 실행 위치: Daytona 샌드박스 2개 — 탐지·검증 에이전트 각 1개 (구현 예정)

## 실행

Java 21 JDK가 필요합니다. Gradle은 별도 설치하지 않아도 Wrapper가 내려받습니다. 최초 빌드 시 인터넷 연결이 필요합니다.

### Windows PowerShell

프로젝트 루트에서 실행합니다.

```powershell
.\scripts\dev.ps1
```

스크립트는 `JAVA_HOME`을 우선 사용하고, 설정되지 않은 경우 사용자의 `.jdks` 폴더에서 Java 21을 찾습니다. IntelliJ에서는 프로젝트 SDK와 Gradle JVM을 Java 21로 지정한 뒤 `SubwayAlertApplication`을 실행할 수도 있습니다.

직접 실행하는 경우:

```powershell
$env:JAVA_HOME = 'C:\path\to\jdk-21'
.\gradlew.bat bootRun
```

### macOS / Linux

Java 21이 `JAVA_HOME` 또는 `PATH`에 설정된 상태에서 실행합니다.

```bash
./gradlew bootRun
```

기본 포트는 `8080`입니다. 다른 포트를 쓰려면 `PORT` 환경 변수를 설정합니다.

```powershell
$env:PORT = '8081'
.\scripts\dev.ps1
```

## 실행 확인

```powershell
Invoke-RestMethod http://localhost:8080/actuator/health
```

정상 응답:

```json
{"status":"UP"}
```

아직 웹 화면이 없으므로 `/` 경로의 404는 정상입니다. 현재 준비된 확인 경로는 `/actuator/health`입니다.

## 테스트 / 빌드

```powershell
.\scripts\dev.ps1 -Task test
.\scripts\dev.ps1 -Task build
```

또는:

```bash
./gradlew test
./gradlew build
```

빌드 결과는 `build/libs/`에 생성됩니다. 실행 가능한 JAR은 이름에 `-plain`이 없는 파일입니다.

## 구조

```text
subway-alert/
├── docs/PLAN.md                       # 합의된 기획, 에이전트 역할, 개발 순서
├── scripts/dev.ps1                   # Windows 개발 실행 도우미
├── src/main/java/com/megabridge/subwayalert/
│   └── SubwayAlertApplication.java
├── src/main/resources/application.yml
├── src/test/java/com/megabridge/subwayalert/
│   └── SubwayAlertApplicationTests.java
├── build.gradle
└── gradlew / gradlew.bat
```

## 다음 개발 순서

1. 서울시 위치·도착 API 인증키 연결과 수집 데이터 저장.
2. 로컬 서버에서 Daytona 샌드박스 2개에 작업을 보내고 결과를 받는 연결.
3. 탐지·검증·추가 조회 루프 및 중복 알림 방지.
4. 관심 구간 등록, 에이전트 활동 화면, 시뮬레이션 모드.

실제 API 키는 저장소에 넣지 않습니다. 연동 구현 시 환경 변수 또는 Git에서 제외한 `application-local.yml`을 사용합니다. 현재 코드는 키 없이 실행됩니다. `.env` 파일을 자동으로 읽는 기능은 아직 없습니다.
