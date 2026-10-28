# Texniki imkan araşdırması (Stage 0)

Tarix: 2026-10-28. Yoxlanılan mənbələr: Adobe-un rəsmi Premiere UXP sənədləri və changelog-u, `@adobe/premierepro@26.5.0` rəsmi TypeScript deklarasiyaları (npm), bu PC-də quraşdırılmış Premiere Pro **26.5.2**.

## 1. Premiere versiyası

| Fakt | Mənbə |
|---|---|
| UXP Premiere-də ictimai beta: v25.2 (dekabr 2024) | Adobe changelog |
| UXP rəsmi (GA): **v25.6.0** | Adobe changelog |
| v26.3.0: `create*Action` çağırışları `project.lockedAccess()` daxilində olmalıdır (breaking change) | Adobe changelog |
| v26.5.0: ən son API (bu layihə həmin tiplərə qarşı yoxlanılır) | `@adobe/premierepro@26.5.0` |

**Seçilmiş minimum versiya: Premiere Pro 26.3.0** (`manifest.json → host.minVersion`).
Səbəb: redaktə əməliyyatları 26.3-də tələb olunan `lockedAccess` + `executeTransaction` modelindən istifadə edir; 25.6–26.2 üçün bu davranış sınanmayıb və zəmanət verilmir.

## 2. UXP haqqında yoxlanılmış faktlar

- UXP brauzer deyil, Node.js da deyil. `require('premierepro')` və `require('uxp')` modulları var; `fs`/`child_process` yoxdur.
- Şəbəkə: `WebSocket` **klienti** var, server ola bilməz. Hər domen `requiredPermissions.network.domains`-də sxem ilə (`ws://127.0.0.1:47631`) göstərilməlidir. Ona görə panel → companion istiqamətində qoşulur (companion loopback-da dinləyir).
- Saxlama: `uxp.storage.secureStorage` — plugin token-i orada saxlanılır.
- Panel yalnız açıq olduqda JS işləyir; panel bağlı olarsa API komandaları `plugin_not_connected` xətası qaytarır (yalançı uğur yoxdur).
- **Ekran tutma, səs, video kodlama, OS input UXP-də yoxdur** → bunlar Windows companion-dadır.

## 3. Komanda imkan matrisi

`impl`: **API** = sənədləşdirilmiş UXP DOM; **Klaviatura** = istifadəçinin shortcut profili + fokus yoxlaması ilə SendInput; **Dəstəklənmir** = düymə göstərilmir.
"Yoxlanılır" — host nəticəni müşahidə edib təsdiqləyirmi.

| Əməliyyat | İmplementasiya | Konkret API / üsul | Yoxlanılır | Mərhələ |
|---|---|---|---|---|
| Play/Pause | Klaviatura (`playPause`, default `Space`) | Program Monitor üçün play API yoxdur (`SourceMonitor.play` yalnız Source Monitor) | Bəli*: playhead hərəkəti iki dəfə ölçülür | 1 |
| Kadr irəli/geri, jog | API | `getPlayerPosition` + `SequenceSettings.getVideoFrameRate` + `TickTime.createWithFrameAndFrameRate` + `setPlayerPosition`, sonra geri oxunur | Bəli | 1 |
| Sekvensiyanın əvvəli/sonu | API | `setPlayerPosition(TIME_ZERO / getEndTime())` | Bəli | 1 |
| In / Out | API | `Sequence.createSetInPointAction/createSetOutPointAction` (tranzaksiya) | Bəli | 2 |
| Marker | API | `Markers.getMarkers(seq).createAddMarkerAction` | Bəli | 2 |
| Split / Add Edit | Klaviatura (`addEdit`, default `Ctrl+K`) + əvvəl `focusTimeline` (`Shift+3`) | UXP DOM-da razor API **yoxdur** | Bəli: `getTrackItems` ilə klip sayı əvvəl/sonra; artmırsa **xəta** | 1 |
| Playhead altındakı klipi seç | Klaviatura (`D`) | — | Xeyr | 2 |
| Delete (lift, boşluq qalır) | API | `getSelection` + `SequenceEditor.createRemoveItemsAction(sel, ripple=false)` | Bəli | 2 |
| Ripple delete | API | eyni, `ripple=true`; telefonda qırmızı + basıb saxlamaqla | Bəli | 2 |
| Trim (ripple trim prev/next to playhead) | Klaviatura (`Q` / `W`) | — | Xeyr | 2 |
| Timeline zoom | Klaviatura (`=` / `-`) | — | Xeyr | 2 |
| Undo / Redo | Klaviatura (`Ctrl+Z` / `Ctrl+Shift+Z`) | Undo API **yoxdur** | Xeyr ("göndərildi, yoxlanıla bilmir" kimi göstərilir) | 1 |
| Save | API | `Project.save()` (false → xəta) | Bəli | 1 |
| Track mute | API | `AudioTrack/VideoTrack.setMute` + `isMuted` | Bəli | 2 |
| Track solo | **Dəstəklənmir** | API yoxdur, default shortcut yoxdur | — | — |
| Layihə/sekvensiya statusu | API | `getActiveProject`, `getActiveSequence`, `guid`, `name` | Bəli | 1 |

\* Plugin qoşulu deyilsə, klaviatura komandaları "göndərildi, yoxlanılmadı" kimi qaytarılır.

**Uydurma API-yə qarşı qoruma:** `tools/plugin-typecheck` panel kodunu Adobe-un rəsmi deklarasiyalarına qarşı `tsc --checkJs` ilə yoxlayır. Sınaq: `seq.razorAtPlayhead()` və `project.undo()` yazıldıqda tsc `TS2339` xətası verir (yəni yoxlama həqiqidir). Hazırkı `premiere-plugin/main.js` 0 xəta ilə keçir.

**Shortcut-lar:** heç biri kodda sabit deyil — `%APPDATA%\Premiere Remote\shortcuts.json` profilindən oxunur (default = Premiere-in zavod ayarları). Profildə olmayan shortcut → komanda "dəstəklənmir" olur, təxmin edilmir.

## 4. Seçilmiş arxitektura

```
Android (Kotlin, libwebrtc) ──WSS──► Signaling (Node.js) ◄──WSS── Windows companion (Electron)
        ▲                                                            │  ▲
        └──────── WebRTC: DTLS-SRTP video/audio + SCTP data ─────────┘  │ ws://127.0.0.1:47631 (token)
                 (birbaşa və ya TURN/coturn relay)                       │
                                                            Premiere UXP panel (API əməliyyatları)
```

| Qərar | Səbəb |
|---|---|
| **Electron** companion | Chromium-un hazır WebRTC steki: ekran/pəncərə tutma (WGC), sistem səsi (WASAPI loopback), H.264/VP8 kodlama, GCC adaptiv bitrate, `getStats`. Öz WebRTC/codec yazmırıq. |
| **koffi** (FFI) | Win32 `SendInput`, `SetCursorPos`, `GetForegroundWindow`, `DwmGetWindowAttribute` — kompilyator olmadan, N-API prebuilt. |
| **Node.js signaling** (`ws`) | Kiçik, test olunan, media görmür. |
| **coturn** | Standart TURN, vaxt məhdud HMAC credential-lar. |
| **Android: Kotlin + Compose + `io.github.webrtc-sdk:android`** | Google-un libwebrtc-sinin saxlanılan prebuilt-i; Keystore native. iOS üçün protokol eynidir (JSON + WebRTC). |
| Host = WebRTC offerer | Media host-dadır; ICE restart-ı host idarə edir. |

## 5. Mühüm məhdudiyyətlər (ətraflı: [LIMITATIONS.md](LIMITATIONS.md))

1. **Split/Undo/Play üçün API yoxdur** → klaviatura fallback; Undo nəticəsi yoxlanıla bilmir.
2. **Hardware kodlama:** bu PC-də (Electron 45) Chromium **OpenH264 (proqram)** seçdi; `powerEfficientEncoder=false`. Faktiki kodlayıcı həmişə statistikada göstərilir. 720p30 üçün CPU kifayət edir, amma 1080p60 CPU-nu yükləyə bilər.
3. **Sistem səsi:** Chromium yalnız *default* çıxış cihazından loopback edir. Bu PC-də default cihaz (simsiz qulaqlıq) loopback-a icazə vermədi → companion avtomatik **yalnız video** rejiminə keçdi və telefona bildiriş göndərdi.
4. Windows kilidli olduqda/UAC açıq olduqda input mümkün deyil (UIPI / secure desktop) — bypass edilmir.
5. Pəncərə tutma rejimində Premiere-dən kənar dialoqlar görünmür → telefondan "Capture: whole display" seçilir; host modal dialoqu (`IsWindowEnabled(main)==false`) aşkarlayıb telefona xəbər verir.

## 6. Kiçik sübutlar (həqiqətən icra olundu)

| Sübut | Nəticə |
|---|---|
| Win32 FFI (Node + koffi) | `GetForegroundWindow`, prosesin yolu, `DwmGetWindowAttribute` rect, `GetCursorPos`, `EnumWindows` işlədi |
| Electron companion başlanğıcı | plugin bridge `127.0.0.1:47631`-də dinləyir, DPAPI vault yaradıldı |
| Panel API-ləri | rəsmi 26.5.0 tiplərinə qarşı 0 xəta |
| Ekran tutma + WebRTC | brauzer test klientinə 1280×720 H.264 yayım (bax README → "Nə sınanıb") |
| Real Premiere 26.5.2 + Android emulyatoru | Panel UPIA ilə quraşdırıldı; Status, kadr addımı (dəqiq 3 kadr), Split (klip sayı ilə doğrulandı), Undo, Save (fayl yeniləndi) və Play/Pause (playhead ilə doğrulandı) telefondan işlədi. Manifest-də dar domen siyahısı işləmədi → `"all"`. |
