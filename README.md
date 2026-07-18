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
- 브라우저 `localStorage` 기반 논문 저장
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
node scripts/collect-papers.mjs --self-test
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

`OPENCODE_GO_API_KEY`가 있으면 `opencode-go/deepseek-v4-flash`로 한국어 요약을 생성합니다. 키가 없으면 휴리스틱 템플릿으로 요약합니다.
LLM 요청은 기본 60초 후 중단되고 해당 논문만 템플릿 요약으로 대체됩니다. `OPENCODE_GO_TIMEOUT_MS`로 제한 시간을 조정할 수 있습니다.

```bash
cp .env.example .env
node --env-file=.env scripts/collect-papers.mjs
```

요약 작성 기준은 [docs/summary-guidelines.md](docs/summary-guidelines.md)에 있습니다.

## 자동 갱신

GitHub Actions 워크플로가 매일 09:07 KST에 실행됩니다.

- 워크플로: `.github/workflows/daily-papers.yml`
- 출력 파일: `data/papers.js`
- 필수 secret: `OPENALEX_API_KEY`
- 선택 secret: `OPENCODE_GO_API_KEY`

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
