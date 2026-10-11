# Underwater Blink v2 — 물결

웹캠에 비친 얼굴이 하늘색 수면 아래에 잠긴 것처럼 보이고, 몸짓에 따라 수면이 반응하는 인터랙티브 웹 작업.

**Live:** https://euieuiwon06-glitch.github.io/underwater-blink-v2/

## 인터랙션

| 동작 | 반응 |
| --- | --- |
| 윙크 · 눈 깜빡임 | 감은 눈 위치에서 원형 파장 |
| 입 뻐끔 | 입 위치에서 원형 파장 |
| 주먹 쥐었다 펴기 | 손바닥 위치에서 원형 파장 |
| 손바닥으로 화면 가르기 | 지나간 자리를 따라 수면이 양쪽으로 갈라졌다가 다시 메워짐 |
| 마우스 · 터치 드래그 | 손으로 가르기와 같은 효과 |

- 수면은 파장이 없을 때도 느린 물결로 계속 움직인다.
- 얼굴은 거울처럼 좌우 반전되어 물 아래에서 굴절되어 보인다.
- 영상은 저장되지 않고 브라우저 안에서만 처리된다. 감지는 MediaPipe Face/Hand Landmarker.

## 로컬 실행

`run.bat`을 실행하면 `http://localhost:8792`에서 열린다. `index.html`을 직접 열면(file://) 브라우저 보안 때문에 동작하지 않는다.

## 구조

- `dist/` — 배포되는 정적 사이트 (`index.html`, `app.js`, `styles.css`, `assets/water-surface.png`)
- `serve.py`, `run.bat` — 캐시를 끈 로컬 서버
