# Android app

A native Sandman client for Android with on-device speech-to-text and text-to-speech that can act
as the phone's assistant. It lives in `android/` ([build and layout](../android/README.md)) and talks to the unified API
([API.md](API.md)).

This file is a decision log. **Decided** is the stack. **Open** lists the remaining choices with
their options; when one is decided, its entry moves to **Decided** as one line and the options are
deleted. When **Open** is empty, this file is a short list of the stack.

## Decided

| Layer | Choice |
|---|---|
| Language, UI | Kotlin, Jetpack Compose, Material 3 (dynamic color) |
| Application ID | `net.tobtobxx.sandman.android` |
| Repository | Monorepo: the app lives in `android/` next to the server |
| Architecture | Single activity, Navigation Compose, ViewModel + `StateFlow`; manual DI (one `AppContainer`), no Hilt |
| HTTP | OkHttp; a small hand-written client for the routes in API.md (no Retrofit) |
| Live updates | `okhttp-sse` on `GET /events/stream?after=`, only while the app or a voice session is in the foreground |
| JSON | kotlinx.serialization |
| Local data | Room: the capture outbox and cached views. DataStore: settings, host, token |
| Background work | WorkManager sends the outbox. Each capture carries a `client_msg_id`; `/send` dedupes on it, so retries never file twice |
| Auth | The existing bearer `api.token`, kept in app-private DataStore; backups and device transfer disabled |
| Transport security | Cleartext HTTP allowed, for a server on a private network (Tailscale/WireGuard encrypts the link); `https://` works too |
| Push when closed | UnifiedPush (see below) |
| SDK levels | `minSdk` 29, `targetSdk`/`compileSdk` 37. `minSdk` may rise to 31 or 33 with the speech choice (#88) |
| Build | Gradle 9 (wrapper with checksum), AGP 9 with its built-in Kotlin, Kotlin DSL, version catalog (`gradle/libs.versions.toml`), KSP for Room, JDK 21 toolchain |
| Lint, format | Android Lint, ktlint via Spotless |
| Tests | JUnit, kotlinx-coroutines-test, OkHttp MockWebServer for the API client |
| CI | `.github/workflows/android.yml`: runs on changes to `android/**`; wrapper validation, Spotless, Lint, unit tests, debug APK as build artifact. Lint ignores "newer version available" checks |

### Push: UnifiedPush over Web Push

[UnifiedPush](https://unifiedpush.org) is a protocol, not a service. On the phone, the app
registers with a *distributor* app the user picks (e.g. the ntfy app, pointing at ntfy.sh or a
self-hosted ntfy). Registration returns an endpoint URL plus an RFC 8291 public key and auth
secret. The app sends those to Sandman; Sandman POSTs encrypted messages to the endpoint, and the
distributor wakes the app. No Google services, no Firebase keys.

Since UnifiedPush messages are plain Web Push (RFC 8030, encrypted per RFC 8291, VAPID per
RFC 8292), a browser `PushSubscription` has the same shape: endpoint, `p256dh`, `auth`. So the
server needs one Web Push sender and one `POST /push-subscriptions` route (#43), and it serves the
web client and the Android app alike. This answers DESIGN.md open question 6 (Web Push, ntfy, or
the app's own mechanism): all three at once.

Android side: the `org.unifiedpush.android:connector` library (handles registration, keys and
decryption). If no distributor is installed, the app falls back to SSE while open and tells the
user notifications need a distributor.

## Open

### Speech-to-text and text-to-speech engines (#88)

Engines run on the phone. The client sends text to `/send`; DESIGN.md §6.3 allows that. Options:

- **Platform** (`SpeechRecognizer.createOnDeviceSpeechRecognizer`, API 33+; `TextToSpeech` with an
  offline voice). 0 MB, streaming, German supported. Quality and behaviour depend on the phone
  maker's engine.
- **sherpa-onnx** (Apache-2.0, Android AAR and Kotlin API). One library for voice activity
  detection (Silero), speech-to-text, text-to-speech and keyword spotting; models are swappable.
  - STT models: streaming Zipformer (20–80 MB, true streaming, hotwords from topic titles),
    Moonshine (~30–65 MB, English, very fast on short utterances), Parakeet TDT 0.6B (~600 MB;
    v3 covers 25 European languages incl. German).
  - TTS models: Piper (20–65 MB per voice, German available), Kokoro-82M (~100–330 MB, best
    quality, no German).
- **whisper.cpp** via JNI. Multilingual, initial-prompt biasing, no streaming, slower.
- **ML Kit GenAI Speech Recognition.** On-device, but alpha; the better mode is Pixel 10 only.
- **Picovoice** (Cheetah, Leopard, Orca). Good and small; commercial licence.
- **Vosk.** Streaming, grammar lists; older models, weaker accuracy.

Recommendation: sherpa-onnx, with the platform engines behind the same interface as the fallback
when no model is downloaded. Models are downloaded on first run, never committed.

### Assistant entry points

- `ACTION_ASSIST` activity: makes the app selectable as "Digital assistant app" (long-press power).
  Small.
- `VoiceInteractionService` + session service: overlay over the current app, service stays bound
  while the role is held; needs a `RecognitionService`, which can expose the app's own STT to
  other apps. Medium.
- Quick Settings tile, home-screen widget (Glance), share target, headset button (MediaSession).
- Wake word ("Hey Sandman"): sherpa-onnx keyword spotting, openWakeWord or Porcupine. Needs a
  microphone foreground service with a permanent notification; battery cost.

Recommendation: `ACTION_ASSIST`, tile and share target first; `VoiceInteractionService` and the
headset button next; wake word only if the others are not enough.

### Topic screens: native or WebView

- WebView of the server's `client.html` (the token query parameter is already accepted): full UI
  on day one, replace screens one at a time.
- Native Compose screens from the start: consistent, more work before the app is useful.

Recommendation: Compose for home, voice overlay and needs-you; WebView for topics until replaced.

### Reaching the host

The server binds `::1:8700` and has one shared token (per-client tokens are #44).

- Tailscale or plain WireGuard; bind `api.host` to the tailnet address. Recommended.
- Reverse proxy with TLS on the public internet. Needs per-client tokens first.

### Distribution

- GitHub Releases with a signed APK (install with Obtainium). Needs a signing key as a CI secret
  and a release job on tags.
- F-Droid. Works from a monorepo subdirectory; requires reproducible builds and no proprietary
  dependencies (UnifiedPush fits).
- Google Play. Account, review, and a Play listing; nothing in the stack needs it.
- Local builds only (`./gradlew installDebug`).

### Development environment

- Android Studio with its own SDK; `nix develop` stays Deno-only.
- A separate `devShells.android` in `flake.nix` (Android SDK via nixpkgs). Reproducible, heavy.

### Instrumented tests in CI

- None for now (unit tests only).
- Emulator job (`reactivecircus/android-emulator-runner`) for UI and audio-path tests. Slow and
  sometimes flaky on hosted runners.
