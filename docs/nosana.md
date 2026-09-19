# Nosana 직접 배포 연결

기존 에이전트 프롬프트·작업 흐름·Zod 출력 계약은 유지한다. `Models`에서 제공사를 선택하며 `src/nosana.js`가 기존 Responses 요청을 Ollama의 `/api/chat`으로 변환한다. URL 분석, 코드 작성, 검증 피드백, 문서 이미지 분석, 결과 HTML, 실험 추천, 대안 분석, 리포트는 Qwen을 우선 사용하고 반복 실패 시 기존 OpenAI 클라이언트로 복구한다.

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
NOSANA_OPENAI_FALLBACK=true
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

작업별 수정·비용·동시 실행 제한을 유지한다. 작은 작업의 자동 복구용 호출·토큰 한도는 아래와 같이 명시적으로 제한한다. Ollama는 별도 입력 토큰 사전 계측 API가 없으므로 한 호출의 전체 입력 허용량을 예약한 후 `prompt_eval_count`와 `eval_count`로 정산한다. 실제 사용량이 상한을 넘거나 불명확하면 기존 실패 처리가 적용된다. 이는 정확한 사전 토큰 예측값이 아니다. 서버 문맥 창은 32,768, 출력은 기존 작업별 상한으로 제한한다. 모델 timeout은 최대 180초이며 남은 작업 시간보다 길어지지 않는다.

연결 수립 또는 응답 본문 수신 중의 네트워크 예외도 `NOSANA_CONNECTION`으로 분류한다. 일시적 오류(408·429·5xx)는 1초 뒤 같은 내용으로 한 번 재시도한다. 400 등 요청 거절은 같은 요청을 반복하지 않는다. OpenAI 복구가 활성화되면 Nosana 호출당 최대 60초 및 남은 시간의 1/3로 제한해 복구 시간을 남긴다. 두 시도의 호출 수와 미확정 토큰·비용은 유지한다. 끝난 Nosana 요청은 `abandoned` 상태로 동시 실행 슬롯만 반환하며 미확정 비용을 0으로 정산하지 않는다.

2026-09-19 결과 HTML·실험 카드 요청의 복잡한 길이·개수 제약 스키마가 HTTP 400을 유발하는 것을 실제 비교 호출로 확인했다. Ollama decoding grammar에는 구조·타입·필수 키·enum을 전달하고 원래 전체 제약은 프롬프트와 최종 Zod 검증에 유지한다. 크기 제한을 통과하지 못한 출력은 성공으로 사용하지 않는다.

SDXL은 카드 선택 시 한 번만 요청한다. 768×768 이미지 1장, 20 steps로 고정하며 최대 120초 안에서 확인한다. 생성 결과는 1MB 이하 JPEG로 변환한다. 이미지 요청 횟수는 공통 ledger에 기록하지만 확산 모델을 언어 토큰으로 환산하지 않는다. 연결 실패 시 Nosana에 이미지를 중복 제출하지 않는다. 자동 복구가 켜져 있으면 OpenAI에 한 번 요청하며, 시간 초과한 Nosana 생성이 원격에서 끝났는지는 미확정으로 남긴다.

## OpenAI 복구

`OPENAI_API_KEY`가 있고 `NOSANA_OPENAI_FALLBACK=false`가 아니면 자동 복구한다. Nosana의 일시적 오류는 최대 두 번 시도 후 OpenAI를 한 번 호출한다. 요청 거절·배포 만료·누락된 연결 설정·잘못된 출력은 바로 OpenAI로 전환한다. 같은 프롬프트·문서 이미지·엄격한 출력 스키마를 사용하며, 역할에 따라 기존 Luna/Terra/Sol 모델을 선택한다. 이미지 생성도 SDXL 한 번 실패 후 `gpt-image-1-mini` 한 번으로 복구한다. OpenAI 요청 실패를 Nosana로 되돌리거나 별도 무한 재시도하지 않는다.

전환 후 해당 제공사 경로(언어/이미지 각각)는 5분 동안 OpenAI를 사용하고 이후 Nosana를 다시 시도한다. 사용자 취소, 작업 만료, 비용·토큰·호출 한도 초과, 검증된 정책 위반은 복구 호출을 시작하지 않는다. 자동 복구를 끄거나 OpenAI 키가 없으면 기존 Nosana 오류로 종료한다. Nosana 배포 만료 후에도 OpenAI 복구가 설정돼 있으면 URL 접수가 가능하다.

OpenAI 입력 토큰은 기존 계측 API로 확인하고 생성 전에 비용을 공통 원장에 예약한다. 작업·프로젝트·사용자·서비스 금액 상한과 활성 시간은 증가하지 않는다. 호출 1~3회로 끝나던 추천·결과 화면·리포트 같은 작은 작업에는 복구용 호출 최대 2회(이미지는 1회)와 그에 필요한 토큰 한도를 명시적으로 추가한다. 이는 새 작업에만 적용되며 일일/프로젝트 금액 상한을 우회하지 않는다. 일반 준비 작업의 48회 상한은 유지한다. 실제 모델명·전환 이유·OpenAI 사용 횟수와 비용을 기록·표시한다.

`.env` 또는 호스팅 환경변수의 `MODEL_PROVIDER=openai`로 바꾸고 재시작하면 수동 전환도 가능하다. 자동 복구는 Nosana GPU를 중지하거나 연장하지 않으며 임대료는 기존 종료 시각까지 별도다.

공식 문서: [OpenAI 오류 처리](https://developers.openai.com/ko-KR/api/docs/guides/error-codes), [Ollama API](https://docs.ollama.com/api/chat), [구조화 출력](https://docs.ollama.com/capabilities/structured-outputs), [Nosana 배포 옵션](https://learn.nosana.com/deployments/options.html), [ComfyUI API](https://docs.comfy.org/development/comfyui-server/comms_routes).
