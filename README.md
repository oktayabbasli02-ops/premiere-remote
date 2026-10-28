# Premiere Remote

Evdəki Windows PC-də işləyən **Adobe Premiere Pro**-nu Android telefondan internet üzərindən (mobil data və ya başqa Wi-Fi) canlı görüntü + səslə idarə etmək və redaktə etmək. Router-də port açmaq lazım deyil.

> Status: **Stage 1 (vertical slice) yazılıb və hissə-hissə sınanıb; Stage 2-nin çox hissəsi daxildir.** Nəyin həqiqətən sınandığı aşağıda dəqiq yazılıb — sınanmayan heç nə "işləyir" kimi göstərilmir.

## Komponentlər

| Qovluq | Nədir | Texnologiya |
|---|---|---|
| [`premiere-plugin/`](premiere-plugin) | Premiere daxilində panel: remote access aç/bağla, 8 rəqəmli kod + QR, təsdiqlər, cihazlar, revoke; rəsmi API ilə redaktə əməliyyatları | Adobe UXP (manifest v5), Premiere **26.3+** |
| [`companion/`](companion) | Windows tray tətbiqi: ekran/pəncərə + sistem səsi tutma, WebRTC yayımı, mouse/klaviatura (SendInput), panel körpüsü, DPAPI vault | Electron 45, koffi (Win32 FFI), ws |
| [`server/`](server) | Minimal pairing + signaling servisi (media görmür) | Node.js 20+, ws |
| [`android/`](android) | Telefon tətbiqi: pairing, canlı görüntü, touch/trackpad, redaktə düymələri, jog wheel, statistika | Kotlin, Jetpack Compose, libwebrtc (`io.github.webrtc-sdk:android`), Android Keystore |
| [`web-client/`](web-client) | iPhone/iPad (və istənilən brauzer) üçün PWA: pairing, canlı görüntü, toxunma/trackpad, redaktə düymələri, jog wheel. Server `/app/` ünvanında paylayır | HTML/JS (build yoxdur), WebCrypto, WebRTC |
| [`ios/`](ios) | Native iOS/iPadOS tətbiqi (Secure Enclave açarı, Keychain, Metal video) — Mac və ya GitHub Actions ilə qurulur; bax [docs/IOS.md](docs/IOS.md) | Swift, SwiftUI, `stasel/WebRTC`, XcodeGen |
| [`shared/`](shared) | Protokol, komanda kataloqu, koordinat xəritələnməsi, dedup journal, ECDSA auth | JS (ESM) — Kotlin güzgüsü `android/.../protocol` |
| [`deploy/`](deploy) | Docker Compose: signaling + Caddy (TLS) + coturn (TURN) | |
| [`tools/`](tools) | `plugin-typecheck` (panel kodunu Adobe-un rəsmi tiplərinə qarşı yoxlayır), `web-test-client` (brauzerdə telefon emulyatoru — inkişaf üçün) | |
| [`docs/`](docs) | [Feasibility + imkan matrisi](docs/FEASIBILITY.md) · [Təhlükəsizlik](docs/SECURITY.md) · [Protokol](docs/PROTOCOL.md) · [Host tələbləri/məhdudiyyətlər](docs/LIMITATIONS.md) · [Deploy, xərc, lisenziyalar](docs/DEPLOYMENT.md) · [E2E test siyahısı](docs/E2E-CHECKLIST.md) | |

```
Telefon ──WSS──► Signaling server ◄──WSS── Companion (PC) ◄──ws://127.0.0.1── Premiere paneli
   ▲                                          │
   └──── WebRTC (DTLS-SRTP video/səs + data) ─┘   birbaşa və ya TURN relay ilə
```

## Nə sınanıb (bu PC-də, 2026-10-28)

| Test | Nəticə |
|---|---|
| `shared` unit testləri (mapping, dedup, auth, redaction, kataloq) | ✅ 24/24 |
| `server` testləri (kod ömrü, single-use, öndəki sıfırlar, toqquşma, rate-limit, brute-force, TURN creds, real HTTP+WS ilə pairing→session→signal→revoke) | ✅ 16/16 |
| `companion` testləri (key parser, executor fokus/dialoq/yoxlama, sessiya auth + MITM, dedup, reconnect query, view-only, koordinat, stale epoch, stuck button) | ✅ 24/24 |
| Panel kodu ↔ `@adobe/premierepro@26.5.0` rəsmi tipləri (`tsc --checkJs`) | ✅ 0 xəta; uydurma metodlar (`razorAtPlayhead`, `undo`) sınaqda xəta verdi |
| Companion Electron-da işə düşür, Win32 FFI işləyir | ✅ |
| **Lokal uçdan-uca** (server + companion + brauzer test klienti): pairing kodu → PC-də təsdiq (açar ID-ləri eyni) → sessiya təsdiqi → qarşılıqlı ECDSA auth (host imzası telefonda ✅) → **1280×720 H.264 video** telefona çatdı | ✅ |
| Premiere işləmədikdə komandalar dürüst xəta qaytarır; eyni ID ilə təkrar komanda icra olunmur (`duplicate:true`); Premiere-dən kənar klik bloklanır; `Win+R` rədd edilir | ✅ |
| Unattended etibarlı cihaz təsdiqsiz qoşulur; revoke → telefon `4003` ilə kəsilir | ✅ |
| Loglarda pairing kodu / token / SDP yoxdur; server yalnız token hash saxlayır; vault şifrəlidir | ✅ |
| Plugin körpüsü: brauzer origin → 403; Premiere olmayan proses (`node.exe`) → rədd | ✅ |
| Windows installer `companion/dist/Premiere Remote Setup 0.1.0.exe` (imzasız, 120 MB) quruldu; qablaşdırılmış exe işə düşür | ✅ |
| **Android debug APK** `android/app/build/outputs/apk/debug/app-debug.apk` (61 MB, minSdk 26, arm64/armv7/x86/x86_64 WebRTC) quruldu, Kotlin xəbərdarlığı yoxdur | ✅ |
| Kotlin unit testləri (koordinat xəritələnməsi + JS ilə eyni protokol/açar ID vektorları) | ✅ 11/11 |
| **Android emulyatorunda (API 35, x86_64) real APK ilə E2E**, lokal server + companion: QR deep link (`premiereremote://pair`) server URL və öndə sıfırlı kodu (`07726316`) doldurdu → Keystore açar ID-si PC-də eyni göründü (557C-F3B1) → təsdiq → canlı 1280×720 H.264 video (Android hardware decoder) → host imzası Android-də yoxlandı (LIVE) | ✅ |
| Emulyatordan komandalar: ◀1 → "panel not open", Split → "Premiere Pro is not running" (dürüst xəta, tam dövrə); videoya toxunma → normallaşdırılmış koordinat PC ekranına xəritələndi və "outside Premiere" kimi bloklandı; Stats: Network RTT 1 ms, App RTT 1–2 ms, path direct | ✅ |
| Emulyatorda Wi-Fi + data söndürülüb açıldı → avtomatik yeni sessiya, unattended cihaz təsdiqsiz yenidən autentifikasiya | ✅ |
| Hostdan revoke → telefonda "Access revoked", düymələr deaktiv | ✅ |
| **Real Premiere Pro 26.5.2-də panel** (`.ccx` UPIA ilə quraşdırıldı): Window › UXP Plugins › Premiere Remote açılır; companion-a qoşulan prosesin `Adobe Premiere Pro.exe` olduğu təsdiqləndi; ilk qoşulmada təsdiq dialoqu, sonra token ilə dialoqsuz qoşulma | ✅ |
| Panel API ilə real layihəni oxuyur: layihə adı, "Sequence 01", 23.976 fps, uzunluq | ✅ |
| **Emulyatordan real əmrlər** (Premiere pəncərəsi tutulub yayımlanır): 1▶ ×3 → playhead tam 3 kadr (0.125125 s, Premiere `00:00:00:03`) "done" · **Split** → V1/A1 3-cü kadrda kəsildi, klip sayı ilə doğrulandı "done" · **Undo** → kəsik geri qayıtdı ("sent — cannot be verified") · **Save** → `.prproj` faylı yeniləndi "done" · **Play/Pause** → oynadı və dayandı, playhead ilə doğrulandı | ✅ |
| Premiere öne gətirilə bilmədikdə klaviatura əmri **göndərilmir**, telefonda "Could not bring Premiere to the foreground" | ✅ |
| **iPhone/iPad PWA** (375×812 toxunma emulyasiyası): QR linki → pairing → təsdiq → canlı video → toxunma və əmrlər; **WebKit (Safari mühərriki)** iPhone profilində pairing və tərtibat. Ətraflı: [docs/IOS.md](docs/IOS.md) | ✅ (WebKit-də video sınanmayıb — Windows WebKit-də WebRTC yoxdur) |
| Native iOS (Swift) | ❌ Mac olmadığı üçün kompilyasiya olunmayıb; `.github/workflows/ios.yml` iPhone Simulator-da qurub test edir |

## Nə sınanmayıb / məlum problemlər

| Mövzu | Vəziyyət |
|---|---|
| **Android APK real telefonda** | ⚠️ Emulyatorda sınanıb; real telefonda (hardware Keystore/StrongBox, mobil data, real toxunma jestləri, pinch-zoom, trackpad, jog wheel) hələ yox. Komandaların **uğurlu** icrası Premiere + panel olmadan sınana bilmədi. |
| **Panel API-lərinin bir hissəsi** | ⚠️ Real Premiere-də sınananlar: status, kadr addımı, save, oxuma (split yoxlaması üçün `getTrackItems`). Sınanmayanlar: In/Out, Marker, Lift/Ripple delete, Track mute, Go to start/end. |
| **Manifest şəbəkə icazəsi** | ⚠️ Premiere 26.5.2 `"domains": ["ws://127.0.0.1:47631", …]` massivini qəbul etmədi ("Manifest entry not found") — bu, Adobe forumunda bilinən problemdir. İşlək yeganə forma `"domains": "all"`-dur, ona görə manifest belədir. Panel kodu yalnız `ws://127.0.0.1:47631`-ə qoşulur; bax [SECURITY.md](docs/SECURITY.md). |
| **Klaviatura əmrləri və ön plan** | ⚠️ Bir dəfə telefondan Zoom + ard-arda 6 dəfə basılanda Premiere **Audio workspace**-ə keçdi (Alt+Shift+3) və səbəbi təkrarlana bilmədi; `Shift+3` və `=` ayrıca sınaqda düzgün işlədi. Windows bəzən başqa proqramın öndən çəkilməsinə icazə vermir — onda əmr göndərilmir və xəta qaytarılır. |
| **Fərqli şəbəkələr / TURN** | ❌ Sınanmayıb (TURN serveri qurulmayıb). Lokal testdə əlaqə `host/host` (birbaşa) idi. |
| **Sistem səsi** | ⚠️ Bu PC-də default çıxış (simsiz qulaqlıq) loopback-a icazə vermədi → companion avtomatik **yalnız video** rejiminə keçdi və telefona bildiriş göndərdi. Başqa aktiv default cihazla sınanmalıdır. |
| **Hardware kodlama** | ⚠️ Chromium bu PC-də **OpenH264 (CPU)** seçdi. Faktiki kodlayıcı statistikada göstərilir. |
| **Real Premiere-də split/undo/save, glass-to-glass latency** | ❌ Sınanmayıb — [E2E siyahısı](docs/E2E-CHECKLIST.md). |
| Sertifikatla imzalama (installer, APK release, .ccx) | Edilməyib. |

## Qurulum

### 1. Server (bir dəfə)
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — VPS + domen + `docker compose up -d`. Lokal sınaq üçün:

```bash
cd server && npm install && node --env-file=.env.example src/index.js
```

### 2. Windows companion
Hazır installer: `companion\dist\Premiere Remote Setup 0.1.0.exe` (imzasız olduğu üçün SmartScreen xəbərdarlıq edəcək). Və ya mənbədən:

```bash
cd companion
npm install
npx install-electron
npm start
```

Installer yenidən qurmaq:

```bash
npm run dist
```

Companion pəncərəsində: **Server URL** (`https://signal.example.com`), lazım olsa **Registration key** → *Save settings*. Shortcut profili: *Open config folder* → `shortcuts.json` (nümunə: [`companion/shortcuts.example.json`](companion/shortcuts.example.json)).

### 3. Premiere paneli
- **İnkişaf:** Creative Cloud-dan *UXP Developer Tool* quraşdırın → Premiere-də *Settings › Plugins › Enable Developer Mode* → UDT-də *Add Plugin* → `premiere-plugin/manifest.json` → *Load*.
- **Paylama (UDT lazım deyil — bu PC-də belə sınanıb):** `.ccx` yaratmaq üçün

```bash
powershell -ExecutionPolicy Bypass -File tools\package-plugin.ps1
```

nəticə: `dist\com.premiereremote.panel_premierepro.ccx` (imzasız; UPIA qəbul etdi). Quraşdırma: `.ccx`-ə iki dəfə klik, və ya:

```bash
"C:\Program Files\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe" /install premiere-remote.ccx
```

Panel: **Window › UXP Plugins › Premiere Remote**. İlk açılışda companion "Allow the panel?" soruşur.

### 4. Android APK
Lazımdır: **JDK 17** və **Android SDK** (platform 35, build-tools 35). Gradle wrapper (8.11.1) repodadır. Bu PC-də quraşdırılıb: JDK → `%LOCALAPPDATA%\PremiereRemoteToolchain\jdk\jdk-17.0.20.1+1`, SDK → `%LOCALAPPDATA%\Android\Sdk`. `JAVA_HOME` JDK 17-yə yönəlməlidir; `android/local.properties` faylında `sdk.dir` olmalıdır (git-ə düşmür).

Debug APK (`app/build/outputs/apk/debug/app-debug.apk`), `android/` qovluğunda:

```bash
./gradlew assembleDebug
```

Unit testlər (koordinat və protokol vektorları JS ilə eyni):

```bash
./gradlew testDebugUnitTest
```

Release (açar mühit dəyişənlərindən oxunur — repoda sirr yoxdur): `PR_KEYSTORE`, `PR_KEYSTORE_PASSWORD`, `PR_KEY_ALIAS`, `PR_KEY_PASSWORD`, sonra:

```bash
./gradlew assembleRelease
```

Android Studio ilə: *Open* → `android/` qovluğu → Run.

### 5. İstifadə
1. Premiere-də paneli açın → **Enable remote access** → kod və QR görünür.
2. Telefonda tətbiq → server URL + 8 rəqəm (və ya QR-ı istənilən skanerlə oxuyun — `premiereremote://pair` linki tətbiqi açır).
3. PC-də sorğu: **açar ID-si telefondakı ilə eyni olmalıdır** → *Approve: view + control* (istəyə görə *unattended*).
4. *Connect* → canlı görüntü. Yuxarıda *Touch/Trackpad*, *Stats*, ⋮ menyusu (capture: pəncərə/ekran, keyfiyyət, keyboard, disconnect); aşağıda redaktə düymələri və jog wheel. ⌨ işarəli düymələr shortcut kimi göndərilir.
5. Dayandırmaq: paneldə/companion-da/tray-də **Stop remote access**; telefonu silmək: **Revoke**.

## Testləri işə salmaq

```bash
cd shared && node --test "test/*.test.js"
cd server && npm install && npm test
cd companion && npm install && npm test
cd tools/plugin-typecheck && npm install && npm run typecheck
```

Brauzer test klienti (Android olmadan protokolu sınamaq üçün):

```bash
node tools/web-test-client/serve.mjs
```

sonra `http://127.0.0.1:8790` — server `127.0.0.1:8787`-də, companion-un Server URL-i `http://127.0.0.1:8787` olmalıdır.

## Fərziyyələr

- Bir PC-yə eyni anda bir telefon qoşulur (ikinci telefon `busy` alır).
- Premiere-in default Windows shortcut-ları (US layout) başlanğıc profildir; dəyişdirmisinizsə `shortcuts.json`-u yeniləyin.
- Premiere-in auto-save ayarlarına toxunulmur; companion sadəcə N dəqiqədə bir "Save" xatırlatması göndərir (ayarlanır, 0 = söndür).
- Layihə və media PC-də qalır; heç nə buluda yüklənmir.

## Qalan işlər (növbəti mərhələlər)

- APK-nı real telefonda E2E siyahısı ilə sınamaq; Premiere-də paneli yükləyib API əməliyyatlarını real layihədə yoxlamaq.
- TURN-u deploy edib mobil data ilə sınamaq.
- Hardware encoder: Electron/Chromium-un MF H.264 yolunu bu GPU-da aktivləşdirmək və ya ölçüb sənədləşdirmək.
- Companion-da shortcut profili redaktoru (indi JSON fayl), düymə düzülüşünü telefonda konfiqurasiya, iOS klienti (protokol eynidir).
- Kod imzalama (Authenticode, APK release key, Adobe Marketplace).
