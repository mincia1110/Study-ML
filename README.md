# Study-ML

최신 ML/CV/LLM arXiv 논문을 골라 한국어로 요약해 보여주는 정적 웹페이지입니다.

## 바로 보기

의존성 설치 없이 브라우저에서 `index.html`을 열면 됩니다.

```bash
open index.html
```

로컬 서버로 확인하고 싶으면:

```bash
python3 -m http.server 8000
```

그 다음 `http://localhost:8000`으로 접속합니다.

## 기능

- arXiv 논문 카드 목록
- 제목, 저자, 태그, 요약, arXiv ID 검색
- 최신 및 최근 1주, 1달, 6개월, 1년 citation 추천
- CV, LLM, Multimodal 분야 필터
- 데이터 갱신과 무관하게 유지되는 브라우저 즐겨찾기 라이브러리
- 즐겨찾기 JSON 내보내기·가져오기
- 논문별 문제, 방법, 시사점 상세 요약

## 논문 데이터 갱신

Node 18 이상이 필요합니다. 외부 패키지는 없습니다.

```bash
node scripts/collect-papers.mjs
```

이 명령은 arXiv에서 논문을 가져오고, OpenAlex citation 정보를 결합해 `data/papers.js`를 다시 생성합니다.

미리보기만 하려면:

```bash
node scripts/collect-papers.mjs --dry-run
```

간단한 자체 검사는:

```bash
node scripts/favorites-self-test.cjs
node scripts/collect-papers.mjs --self-test
node scripts/summary-self-test.mjs
```

OpenAlex 없이 기존 최신 추천만 갱신하려면:

```bash
node scripts/collect-papers.mjs --latest-only
```

## Citation 추천

[OpenAlex 설정](https://openalex.org/settings/api)에서 무료 API key를 발급한 뒤 `OPENALEX_API_KEY`로 설정합니다.
키가 없거나 OpenAlex 요청이 실패하면 기존 citation 추천은 보존되고 최신 추천만 갱신됩니다.

```bash
OPENALEX_API_KEY=... node scripts/collect-papers.mjs --dry-run
```

Citation 수는 OpenAlex 기준이며 제공자별로 다를 수 있습니다. 특히 최근 1주·1달 논문은 집계가 늦거나 모두 0일 수 있습니다.

## LLM 요약

`OPENCODE_GO_API_KEY`가 있으면 `opencode-go/deepseek-v4.1-flash`로 한국어 요약을 생성합니다. `OPENCODE_GO_MODEL` 환경변수로 API 모델 ID를 변경할 수 있습니다. 키가 없거나 응답 형식이 올바르지 않으면 원문과 초록을 확인하라는 안내를 표시합니다.
`401 authentication_error`가 발생하면 OpenCode Console에서 키 만료·폐기 여부를 확인하고, 필요하면 새 키를 생성해 로컬 설정과 GitHub Actions의 `OPENCODE_GO_API_KEY` secret을 교체합니다. 만료된 키는 재로그인으로 갱신되지 않습니다. 모델 ID는 [Go 모델 목록 API](https://opencode.ai/zen/go/v1/models)에서 확인할 수 있습니다. `--require-summaries` 실행은 요약이 누락되면 기존 데이터를 덮어쓰지 않고 실패합니다.
LLM 요청은 매 시도마다 기본 60초 후 중단됩니다. `OPENCODE_GO_TIMEOUT_MS`로 제한 시간을 조정할 수 있습니다. 재시도 후에도 요약을 얻지 못하면 해당 논문을 안내 문구로 대체합니다.
HTTP 429·500·502·503·504와 시간 초과는 기본 3회 재시도합니다(최초 요청 포함 총 4회). 서버 오류와 시간 초과는 5초·10초·20초, 429는 10초·20초·40초 대기하며 `Retry-After`가 더 길면 그 값을 따릅니다. 대기가 60초를 넘으면 재시도하지 않고 해당 요약을 실패 처리합니다. `OPENCODE_GO_MAX_RETRIES`는 0으로 끌 수 있고 최대 3회까지 설정할 수 있습니다. 인증 오류·잘못된 응답·그 밖의 네트워크 오류는 재시도하지 않습니다.

arXiv 요청은 식별 가능한 `User-Agent`와 Atom/XML을 허용하는 `Accept`를 보내고, [이용 정책](https://info.arxiv.org/help/api/tou.html)에 맞춰 최소 3초 간격으로 직렬 실행합니다. HTTP 429는 기본 30초부터, 다른 일시적 오류는 5초부터 지수 backoff하며 `Retry-After`가 더 길면 이를 우선합니다. 429 이후 연결 오류나 시간 초과가 발생해도 긴 backoff를 유지합니다. 기본 최대 4회 재시도하며 `ARXIV_REQUEST_TIMEOUT_MS`, `ARXIV_MAX_RETRIES`, `ARXIV_RATE_LIMIT_RETRY_MS`로 제한을 조정할 수 있습니다. `ARXIV_MAX_RETRIES=0`은 재시도를 끕니다.

최신 논문 검색이 HTTP 406·429·500·502·503·504, 연결 오류, 시간 초과 또는 잘못된 피드로 실패하면 [공식 일일 Atom 피드](https://info.arxiv.org/help/rss.html)에서 cs.CV·cs.CL 새 논문을 가져옵니다. API와 같은 분야·키워드 기준으로 선별하며, 수정·교차 공지와 7일보다 오래된 공지는 제외합니다. 같은 클라이언트를 사용하므로 마지막 오류의 `Retry-After`와 요청 간격도 유지합니다. 부분적으로 성공한 API 결과는 섞지 않습니다. 피드도 실패하거나 유효한 새 논문이 없으면 기존 파일을 보존하고 실패합니다.

피드로 수집한 경우 `PAPER_METADATA.latest`에 `source: arxiv-atom`, `status: fallback`, `dateBasis: announced`, `fallbackReason`을 기록합니다. 이 경우 논문 날짜는 제출일 대신 공식 공지일입니다. 정상 API 수집은 `source: arxiv-api`, `dateBasis: submitted`입니다. API 장애 중에는 citation 메타데이터 요청을 반복하지 않고 기존 citation 추천을 보존하며 `citation.status`를 `stale-cache`로 기록합니다. 한국어 요약 검증과 `--require-summaries`의 파일 보호는 대체 경로에도 적용됩니다.

이 대응은 [2026-10-27 실행의 첫 요청 HTTP 406](https://github.com/mincia1110/Study-ML/actions/runs/40473933562)과 [2026-10-28 실행의 반복 HTTP 429 및 중간 시간 초과](https://github.com/mincia1110/Study-ML/actions/runs/40657221078)를 바탕으로 추가했습니다. 406의 정확한 서버 측 원인은 로그만으로 확정할 수 없습니다.

```bash
cp .env.example .env
node --env-file=.env scripts/collect-papers.mjs
```

요약 작성 기준은 [docs/summary-guidelines.md](docs/summary-guidelines.md)에 있습니다.

## 자동 갱신

GitHub Actions 워크플로는 현재 수동 `workflow_dispatch` 실행을 지원합니다. 실행하면 논문 데이터를 수집하고 변경된 `data/papers.js`만 자동 커밋합니다.
같은 저장소의 수집 실행은 `concurrency`로 직렬화하며, 수집 전에 자체 검사와 모의 HTTP 통합 검사를 실행합니다. 완료 알림에는 해당 Actions 실행 링크를 포함합니다.

- 워크플로: `.github/workflows/daily-papers.yml`
- 출력 파일: `data/papers.js`
- 필수 secret: `OPENALEX_API_KEY`
- 선택 secret: `OPENCODE_GO_API_KEY`
- 완료 알림: `NTFY_TOPIC` secret에 저장된 비공개 ntfy topic으로 성공·실패 결과와 실행 링크를 전송

## 구조

```text
.
├── index.html                  # 정적 페이지
├── styles.css                  # 화면 스타일
├── app.js                      # 검색, 필터, 저장, 상세 보기
├── data/papers.js              # 생성된 논문 데이터
├── scripts/collect-papers.mjs  # 전체 수집 및 요약 생성
├── scripts/lib/                # citation 추천, OpenAlex, 캐시 로직
├── docs/summary-guidelines.md  # 요약 작성 기준
└── assets/hero-ml-cv.png       # 히어로 이미지
```

## 주의

요약은 자동 생성됩니다. 연구나 인용에 사용할 때는 arXiv 원문과 PDF를 확인하세요.
