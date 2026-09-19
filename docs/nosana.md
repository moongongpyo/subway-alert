# Nosana 직접 배포 연결

기존 에이전트 프롬프트·작업 흐름·Zod 출력 계약은 유지한다. `Models`에서 제공사를 선택하며 `src/nosana.js`가 기존 Responses 요청을 Ollama의 `/api/chat`으로 변환한다. URL 분석, 코드 작성, 검증 피드백, 문서 이미지 분석, 결과 HTML, 실험 추천, 대안 분석, 리포트 모두 같은 Qwen 서버를 사용한다.

## 배포

- 언어·이미지 분석: Qwen 3.6 35B-A3B Q8, Ollama 0.32.6, A6000 48GB.
- 실험 이미지 생성: SDXL, Nosana ComfyUI 2.0.11, 3090 24GB.
- 각각 Simple, replica 1, timeout 6시간. 자동 재시작·연장·새 배포 생성 코드는 없다.
- 2026-09-19 대시보드 표시 요금은 각각 $0.400/시간, $0.192/시간. 6시간씩 표시 요금 합계 $3.552. 실제 청구는 Nosana 크레딧 내역을 기준으로 확인한다.
- 직접 배포는 요청이 없어도 GPU 가동 시간으로 과금된다. 작업별 토큰 비용에 임대료를 0달러로 합산하지 않는다.

`NOSANA_INFERENCE_TOKEN`을 설정하고 `node deploy/build-nosana.mjs`를 실행하면 `.deploy/nosana-qwen.json`과 `.deploy/nosana-sdxl.json`을 만든다. 이 명령은 유료 배포를 시작하지 않는다. Nosana 편집기에 JSON을 붙여넣고 다른 곳을 클릭한 뒤 Save로 적용한다. Simple / replica 1 / 6시간과 GPU 요금을 별도로 확인한다. JSON에는 토큰 원문 대신 SHA-256만 들어간다.

공식 템플릿의 `/models` 마운트를 사용하되 `OLLAMA_MODELS=/models`를 반드시 함께 설정한다. SDXL은 Hugging Face 공식 저장소에서 체크포인트 파일 하나만 가져온다. 배포 뒤 `/api/tags`의 Qwen 이름과 ComfyUI 체크포인트를 모두 확인해야 한다. HTTP 200만으로 준비 완료를 판단하지 않는다.

2026-09-19 초기 설정 보정으로 두 배포를 각각 한 번 교체했다. 이전 두 실행과 새 두 실행을 모두 6시간으로 계산한 보수적 표시 요금 상한은 $7.104이며, 승인된 $10 안이다. 이전 실행은 교체 시 중지됐으므로 이것은 실제 사용액이 아니다. 앱의 만료 시각은 최초 배포 기준을 유지해 새 GPU 종료보다 일찍 호출을 차단한다.

## 환경변수

```dotenv
MODEL_PROVIDER=nosana
NOSANA_BASE_URL=https://YOUR-OLLAMA-ENDPOINT
NOSANA_INFERENCE_TOKEN=
NOSANA_EXPIRES_AT=DEPLOYMENT_END_UTC_ISO_TIMESTAMP
NOSANA_HOURLY_USD=0.592
NOSANA_MAX_USD=7.104
NOSANA_IMAGE_BASE_URL=https://YOUR-COMFYUI-ENDPOINT
NOSANA_IMAGE_TOKEN=
NOSANA_IMAGE_EXPIRES_AT=IMAGE_DEPLOYMENT_END_UTC_ISO_TIMESTAMP
```

주소는 직접 배포의 HTTPS endpoint이며 공유 추론 서비스 주소가 아니다. 두 배포 모두 인증 게이트웨이의 8000 포트만 노출한다. INFERENCE_TOKEN과 IMAGE_TOKEN에는 생성기에서 사용한 토큰을 설정한다. 관리 API 키는 추론 endpoint에 보내지 않는다. Ollama와 ComfyUI는 컨테이너 내부 loopback에 바인딩하며, 인증 없는 추론은 401로 차단한다. `/health`는 시작 상태만 확인하므로 별도로 실제 모델 준비 상태를 확인한다.

프로세스 재시작 후 `npm run doctor`로 현재 선택한 언어 모델을 확인한다. 배포의 실제 종료 시각을 환경변수에 기록한다. 앱은 그 시각 이후 새 모델 호출을 차단하지만, 환경변수 자체가 GPU를 중지시키는 것은 아니다. GPU 중지는 Nosana의 Simple/timeout 설정이 담당한다.

## 제한과 계측

기존 작업별 호출·수정·토큰 누계·동시 요청 제한을 유지한다. Ollama는 별도 입력 토큰 사전 계측 API가 없으므로 한 호출의 전체 입력 허용량을 예약한 후 `prompt_eval_count`와 `eval_count`로 정산한다. 실제 사용량이 상한을 넘거나 불명확하면 기존 실패 처리가 적용된다. 이는 정확한 사전 토큰 예측값이 아니다. 서버 문맥 창은 32,768, 출력은 기존 작업별 상한으로 제한한다. 모델 timeout은 최대 180초이며 남은 작업 시간보다 길어지지 않는다.

SDXL은 카드 선택 시 한 번만 요청한다. 768×768 이미지 1장, 20 steps로 고정하며 최대 120초 안에서 확인한다. 생성 결과는 1MB 이하 JPEG로 변환한다. 이미지 요청 횟수는 공통 ledger에 기록하지만 확산 모델을 언어 토큰으로 환산하지 않는다. 연결 실패 시 이미지를 중복 제출하지 않는다.

## OpenAI 복구

기존 OpenAI 클라이언트, 모델 설정, 프롬프트, 키는 보존한다. `.env` 또는 호스팅 환경변수의 `MODEL_PROVIDER=openai`로 바꾸고 서버를 재시작하면 기존 경로로 복구된다. Nosana 오류를 이유로 자동으로 OpenAI를 호출하지 않는다. 앱 연결을 복구해도 이미 실행 중인 Nosana GPU는 해당 배포 화면에서 중지하거나 설정된 종료 시각까지 과금된다.

공식 문서: [Ollama API](https://docs.ollama.com/api/chat), [구조화 출력](https://docs.ollama.com/capabilities/structured-outputs), [Nosana 배포 옵션](https://learn.nosana.com/deployments/options.html), [ComfyUI API](https://docs.comfy.org/development/comfyui-server/comms_routes).
