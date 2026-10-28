# iPhone / iPad

Premiere-in özü Windows PC-də qalır, iPhone/iPad isə idarə cihazıdır. Bunun üçün iki klient var. Hər ikisi Android tətbiqi ilə eyni protokolu, eyni pairing və təhlükəsizlik modelini istifadə edir.

| | **Web tətbiq (PWA)** — `web-client/` | **Native iOS** — `ios/` |
|---|---|---|
| Quraşdırma | Safari → `https://<server>/app/` → Share → *Add to Home Screen* | Xcode ilə Mac-dan; App Store/TestFlight üçün Apple Developer hesabı ($99/il) |
| Mac lazımdır? | Xeyr | Bəli (və ya GitHub Actions macOS runner) |
| Açar saxlanması | WebCrypto, ixrac olunmayan P-256 açarı IndexedDB-də | **Secure Enclave** (Simulator-da Keychain) |
| Token saxlanması | IndexedDB-də, ixrac olunmayan AES-GCM açarı ilə şifrəli | Keychain, `ThisDeviceOnly` |
| Video | Safari WebRTC (H.264 hardware decode) | libwebrtc (`stasel/WebRTC`), Metal renderer |
| Arxa fon | iOS fonda WebRTC-ni dayandırır; qayıdanda tətbiq özü yenidən qoşulur | Eyni; `scenePhase` aktiv olanda yenidən qoşulur |
| Səs | iOS qaydasına görə ilk dəfə "Tap for sound" basmaq lazımdır | `AVAudioSession.playback` |

## QR kod

Panel və companion-dakı QR `https://<server>/app/#pair=KOD` linkidir.
- **iPhone kamerası** bu linki Safari-də açır və kod avtomatik doldurulur.
- **Android-də** səhifə "Open in the Android app" düyməsi göstərir.
- Kod URL **fraqmentindədir** (`#`), ona görə serverə və loglara getmir. Səhifə onu dərhal ünvan sətrindən silir.

## PWA-nı açmaq

Server `/app/` ünvanında PWA-nı API ilə eyni origin-dən paylayır (bax `server/src/static.js`). Server URL soruşulmur, CORS yoxdur.
- Ciddi CSP tətbiq olunur: yalnız öz skriptləri, üçüncü tərəf kodu yoxdur.
- HTTPS (Caddy) lazımdır, çünki WebCrypto və service worker yalnız təhlükəsiz kontekstdə işləyir.

Safari quraşdırılmamış saytların məlumatını 7 gün istifadə olunmadıqda silə bilər. Ana ekrana əlavə edilmiş PWA-lara bu qayda tətbiq olunmur, ona görə **"Add to Home Screen"** tövsiyə olunur.

## Native tətbiqi qurmaq (Mac)

```bash
brew install xcodegen
```

```bash
cd ios && xcodegen generate && open PremiereRemote.xcodeproj
```

Xcode-da *Signing & Capabilities* bölməsində komandanızı (Team) seçin, iPhone-u qoşun və **Run** basın. Pulsuz Apple ID ilə quraşdırılan tətbiq 7 gün işləyir.

Simulator-da testlər:

```bash
xcodebuild test -project PremiereRemote.xcodeproj -scheme PremiereRemote -destination "platform=iOS Simulator,name=iPhone 16" CODE_SIGNING_ALLOWED=NO
```

## Mac olmadan: GitHub Actions

`.github/workflows/ios.yml` faylı repo GitHub-a göndəriləndə işə düşür. O, macOS runner-də aşağıdakıları edir:
- layihəni XcodeGen ilə yaradır;
- mövcud iPhone Simulator-u seçir;
- tətbiqi qurur və unit testləri işlədir (`CoordinateMapperTests`, `ProtocolTests` — JS/Kotlin ilə eyni test vektorları).

Nəticə fayllarını (`.xcresult`, build logu) Actions səhifəsindən yükləmək olar.

## Nə sınanıb (Windows PC-də, 2026-10-28)

| Test | Nəticə |
|---|---|
| Server `/app/` paylaması, CSP, path traversal qoruması (unit test) | ✅ |
| PWA brauzer pəncərəsində 375×812 (toxunma emulyasiyası): QR linki ilə kodun doldurulması → pairing → PC-də təsdiq (açar ID eyni) → **canlı video** → toxunma koordinatı (0.499, 0.500) hosta çatdı → əmrlərə dürüst cavablar | ✅ (Chromium mühərriki) |
| **WebKit (Safari mühərriki)**, Playwright iPhone 15 Pro profili: PWA açılır, WebCrypto ECDSA açarı IndexedDB-də saxlanır, açar ID PC ilə eynidir, pairing PC-də təsdiqləndi; iPhone və iPad tərtibatı ekrana sığır | ✅ |
| WebKit-də video (WebRTC) | ❌ Windows üçün WebKit qurulmasında `RTCPeerConnection` yoxdur — burada sınana bilmir. Tətbiq bu halda aydın mesaj göstərir. |
| **Native iOS kodu** | ❌ Kompilyasiya olunmayıb: iOS SDK/Xcode yalnız macOS-dadır. İlk build-də (Mac və ya GitHub Actions) kiçik kompilyasiya xətaları ola bilər. |
| Real iPhone/iPad Safari | ❌ Sınanmayıb (HTTPS server lazımdır) |

Testdə tapılıb düzəldilən xətalar:
- jog wheel gizli ekranda mənfi radius ilə çəkilib bütün tətbiqi dayandırırdı;
- shared `clampPan()` yalnız `{scale, panX, panY}` qaytarır, və veb klient view ölçülərini itirirdi — bütün toxunmalar atılırdı. Swift testində buna qarşı yoxlama var.
