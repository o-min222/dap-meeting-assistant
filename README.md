# DAP Meeting Assistant

<img src="./assets/icon.svg" alt="DAP Meeting Assistant 아이콘" width="112" height="112">

DAP(Desk AI Pet)용 외부 회의 도우미 플러그인입니다.

회의 중 마이크와 시스템 오디오를 전사하고, 실시간 번역 자막과 상황별 답변 초안을 제공합니다.
회의를 마치면 요약, 결정사항, 액션 아이템, 내 발화 개선이 포함된 리포트를 저장합니다.

## 기능

- 마이크·시스템 오디오 실시간 전사
- Google Translate 기반 실시간 번역 자막
- 동의·반박·질문·제안 답변 초안
- 회의 요약과 종료 리포트
- 미완성 세션 임시 저장 및 리포트 재생성

## 설치

DAP의 `설정 → 플러그인`에서 **Meeting Assistant**를 찾아 설치합니다.

이 플러그인은 다음 권한을 요청합니다.

- `meeting.capture`: 회의 오디오 캡처와 전사 이벤트
- `storage.private`: 회의 초안과 리포트 저장
- `window.palette`: 회의 패널 표시

DAP 1.3.12 이상이 필요합니다. 회의 전사에는 DAP 설정에서 설치한 Whisper `small` 모델과
`whisper-server` 또는 `whisper-cli`가 필요합니다.

## 개인정보와 동의

오디오 원본은 DAP 호스트 내부에서 처리되며 플러그인에는 전사 이벤트만 전달됩니다.
실시간 번역을 켜면 전사 텍스트가 Google Translate 엔드포인트로 전송됩니다.
지역에 따라 회의 녹음 전 상대방의 동의가 필요할 수 있습니다.

## 개발 확인

```sh
npm run check
```

플러그인 API는 [DAP Plugin API](https://github.com/Project-Undonghae/mydeskpet/blob/dev/docs/PLUGIN_API.md)를 참고하세요.

## 라이선스

MIT
