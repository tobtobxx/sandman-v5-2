# Sandman for Android

A Sandman client: send from the home prompt, see what needs you and what finished. Stack and open
decisions: [docs/ANDROID.md](../docs/ANDROID.md).

## Build

Needs JDK 21 and the Android SDK (Android Studio brings both; otherwise set `ANDROID_HOME`).

```sh
cd android
./gradlew installDebug                                   # build and install on a connected phone
./gradlew spotlessApply                                  # format
./gradlew spotlessCheck lint testDebugUnitTest assembleDebug   # what CI runs
```

CI (`.github/workflows/android.yml`) runs on changes to `android/` and uploads the debug APK.

## Connect to the server

The server binds `::1` by default. Make it reachable from the phone, e.g. over Tailscale: set
`api.host` in `config.jsonc` to the host's tailnet address, and set `api.token`. In the app, open
Settings and enter `http://<host>:8700` and the token. Plain HTTP is allowed because the tailnet
encrypts the link; use `https://` for anything public.

## Layout

```
app/src/main/kotlin/io/github/tobtobxx/sandman/
  SandmanApp.kt, AppContainer.kt   application and manual DI
  MainActivity.kt                  single activity, Compose
  data/SettingsStore.kt            server address and token (DataStore)
  data/Outbox.kt, OutboxWorker.kt  captures waiting to be sent (Room + WorkManager)
  data/api/                        API client (OkHttp), event stream (SSE), JSON models
  ui/                              theme, navigation, home and settings screens
app/schemas/                       Room schema history (commit changes)
```
