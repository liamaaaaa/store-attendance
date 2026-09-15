# 매장 GPS 출퇴근 (통합 버전)

근로자가 회원가입 시 근무 매장을 선택하면 매장 좌표가 자동 적용되고, 매장 반경 안에서만 출근·퇴근을 기록할 수 있는 시스템.
관리자가 매장을 1회 등록하면 근로자는 어떤 설정도 하지 않는다.

```
docs/               근로자 앱 + 관리자 페이지 (GitHub Pages)
  index.html        가입/로그인 → 출퇴근 화면
  admin.html        매장 등록(카카오 검색) · 근태 조회 · CSV · 근로자 관리
  config.js         API 주소, 카카오 JS 키, 회사명
worker/             API 서버 (Cloudflare Workers + D1)
  src/index.js      라우터·판정 로직
  schema.sql        D1 스키마
  wrangler.toml     배포 설정
  test/run.mjs      통합 테스트 (node --no-warnings worker/test/run.mjs)
  test/devserver.mjs 로컬 실행 (API :8787, 웹 :8080)
```

## 판정 규칙
- 거리: Haversine · 반경 안: `distance − accuracy ≤ radius` · 오차 100m 초과 시 판정 보류 · 최소 반경 10m
- 서버가 동일 규칙으로 재검증하고, 반경 밖이거나 클라이언트 판정과 불일치하면 `flagged` 표시
- 기록에는 당시 매장 좌표·반경을 함께 저장 (매장 이전 후에도 근거 유지)

## 배포

### 1. API (Cloudflare)
1. Workers & Pages → Create → Worker 이름 `gps-attendance-api` → `worker/src/index.js` 내용 붙여넣기 → Deploy
2. Storage & Databases → D1 → Create `gps-attendance` → Console 탭에서 `worker/schema.sql` 실행
3. Worker → Settings → Bindings → D1 database 추가: 변수명 `DB`, 데이터베이스 `gps-attendance`
4. Worker → Settings → Variables and Secrets
   - `ADMIN_KEY` (Secret): 관리자 페이지 로그인 키 (길고 무작위한 문자열)
   - `ALLOWED_ORIGIN` (Text): `https://liamaaaaa.github.io`
5. 배포 주소 확인: `https://gps-attendance-api.<계정>.workers.dev` → 브라우저에서 열면 `{"ok":true,...}`

### 2. 웹 (GitHub Pages)
1. `docs/config.js`의 `API_BASE`를 1‑5의 주소로, `KAKAO_JS_KEY`를 카카오 JavaScript 키로 수정
2. Settings → Pages → Source: `main` / `/docs`
3. 근로자: `https://liamaaaaa.github.io/<repo>/` · 관리자: `https://liamaaaaa.github.io/<repo>/admin.html`

### 3. 운영 순서
관리자 페이지 로그인 → 매장 등록(검색·반경) → 근로자에게 앱 주소 전달 → 가입 시 매장 선택 → 출퇴근

## API 요약
| 메서드 | 경로 | 인증 | 설명 |
|---|---|---|---|
| GET | /stores | 없음 | 가입용 매장 목록 (좌표 미노출) |
| POST | /auth/signup | 없음 | name, phone, pin, store_id → token |
| POST | /auth/login | 없음 | phone, pin → token |
| GET | /me/store | Bearer | 소속 매장 좌표·반경 |
| POST | /attendance | Bearer | client_record_id, type, recorded_at, lat, lng, accuracy_m, client_in_range |
| GET | /attendance | Bearer | 본인 기록 |
| GET/POST/PUT | /admin/stores | x-admin-key | 매장 조회·등록·수정 |
| GET/POST | /admin/users | x-admin-key | 근로자 조회 · 활성/비활성 · PIN 초기화 |
| GET | /admin/attendance | x-admin-key | store_id, from, to, flagged=1, format=csv |

## 네이티브 앱 이식
판정 로직(`distM`, `evaluate`)과 API 계약을 그대로 사용한다. iOS `CLLocationManager.horizontalAccuracy`, Android `Location.accuracy`를 `accuracy_m`으로 전달.
