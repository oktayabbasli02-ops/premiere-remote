# Əl ilə uçdan-uca test siyahısı

Hər bəndi işarələyin; nəticəni (✅/❌ + qeyd) yazın. Stats ekranında **Path** (direct / TURN relay) və **Network RTT** dəyərlərini qeyd edin.

## A. Quraşdırma
- [ ] Server: `https://<domain>/healthz` → `{"ok":true}`.
- [ ] Companion açılır, tray ikonu görünür, Settings-də server URL saxlanılır.
- [ ] Premiere 26.3+ → Window › UXP Plugins/Extensions › **Premiere Remote** paneli açılır; companion "Allow the panel?" soruşur → Allow → panel "Connected to companion".
- [ ] Companion-u bağlayıb açın: panel token ilə **soruşmadan** yenidən qoşulur.

## B. Pairing (acceptance 1–4)
- [ ] Paneldə **Enable remote access** → 8 rəqəmli kod + QR, geri sayım.
- [ ] Kod öndə sıfırla başlayırsa da (`0…`) telefon onu qəbul edir.
- [ ] Telefon **mobil data**dadır (PC Wi-Fi-da). Kodu daxil edin → PC-də sorğu, **açar ID-ləri eynidir**.
- [ ] "Approve: control" → telefon "Paired".
- [ ] Eyni kodu ikinci dəfə daxil etmək → "wrong, expired or already used".
- [ ] Kodun vaxtı bitdikdən sonra daxil etmək → eyni xəta.
- [ ] 6 səhv kod ard-arda → "Too many attempts".
- [ ] "Reject" → telefon "rejected", kod yanıb.

## C. Yayım (acceptance 5)
- [ ] Connect → PC-də sessiya təsdiqi (unattended deyilsə) → LIVE.
- [ ] Premiere pəncərəsi görünür; timeline-da klip oynadıqda **səs** gəlir (yoxsa bildirişi yoxlayın: default səs cihazı).
- [ ] Stats: ölçü, fps, bitrate, codec, PC encoder (HW/OpenH264), Path.
- [ ] Telefonu döndərin (portret ↔ landşaft): görüntü düzgün sığır, toxunma dəqiq qalır.
- [ ] Pinch-zoom + iki barmaqla pan; zoom-da kiçik düyməyə toxunmaq dəqiq düşür.
- [ ] Quality: 540p → 1080p30 → Auto; Stats-da ölçü dəyişir.
- [ ] **Glass-to-glass latency (əl ilə):** PC-də millisaniyəli saat açın (məs. brauzerdə onlayn stopwatch), telefonu PC ekranının yanında tutub hər ikisini başqa kamera ilə çəkin; şəkildə iki rəqəmin fərqi = gecikmə. 3 ölçmənin ortası: ____ ms (Wi-Fi), ____ ms (mobil data).

## D. Redaktə (acceptance 6)
- [ ] ▶/❚❚ → oynayır/dayanır; ack "done" (yaşıl) və ya "sent" (göy).
- [ ] ◀1 / 1▶ → playhead tam 1 kadr; jog wheel fırlatma → bir neçə kadr, Precision rejimində daha yavaş.
- [ ] |◀ / ▶| → əvvəl/son.
- [ ] Split (playhead klip üzərində) → "Split: done", timeline-da kəsik. Playhead boşluqdadırsa → **xəta** "no clip was split" (yalançı uğur yox).
- [ ] Undo → kəsik geri qayıdır ("sent — cannot be verified").
- [ ] Save → "Save: done"; Premiere başlığında `*` yox olur.
- [ ] In / Out / Marker → timeline-da görünür.
- [ ] Klip seçin → "Lift (gap)" boşluq qoyur; Undo; "Ripple delete (hold)" yalnız basıb saxlayanda işləyir və boşluğu bağlayır.
- [ ] Mute… A1 → səs kəsilir; Unmute.
- [ ] Track solo düyməsi **görünmür** (dəstəklənmir).
- [ ] Touch rejimi: klik, uzun basma = sağ klik (kontekst menyusu açılır), sürükləmə = klipi timeline-da daşımaq.
- [ ] Trackpad rejimi: kursor nisbi hərəkət, tap = klik, iki barmaq tap = sağ klik, iki barmaq sürüşdürmə = scroll, basıb saxla + hərəkət = drag.
- [ ] Keyboard: marker adına mətn yazın; Esc/Enter işləyir.

## E. Fokus, dialoq, xətalar
- [ ] PC-də Notepad-ı öne çıxarın → Undo göndərin: Premiere öne gəlir və ya **"focus_lost"** xətası (Notepad-a Ctrl+Z getməməlidir).
- [ ] Premiere-də modal dialoq açın (məs. Sequence Settings) → Split: **"A Premiere dialog is open"**; telefonda banner.
- [ ] Display capture-a keçin → dialoq görünür, toxunma ilə bağlayın.
- [ ] Paneli bağlayın → Save: "panel is not open" xətası; banner "Premiere panel not open".
- [ ] Premiere-i bağlayın → komandalar "Premiere Pro is not running".
- [ ] Başqa sekvensiyaya keçin və dərhal Split göndərin (köhnə status ilə) → "sequence changed" (köhnə sekvensiyada redaktə edilmir).
- [ ] Desktop-a (Premiere xaricinə) toxunun → "Target is outside Premiere".
- [ ] Windows-u kilidləyin (Win+L, PC-də) → telefonda "Windows is locked", input işləmir; açın → davam edir.

## F. Şəbəkə və yenidən qoşulma (acceptance 7)
- [ ] Wi-Fi → mobil data keçidi sessiya zamanı: RECONNECTING → LIVE (yeni sessiya); təsdiq tələb olunursa PC-də təsdiq.
- [ ] Təyyarə rejimi 5 s → söndür: yenidən qoşulur.
- [ ] Split düyməsini basın və **dərhal** təyyarə rejimini yandırın; qayıdanda: timeline-da **yalnız bir** kəsik; telefon ya "Split: done" (journal-dan), ya da "never reached the PC and was NOT re-sent" göstərir.
- [ ] Yenidən qoşulmadan sonra köhnə drag/scrub hərəkətləri təkrarlanmır (kursor sıçramır).
- [ ] Companion-u yenidən başladın → telefon "PC offline" → avtomatik qoşulur.
- [ ] Mobil şəbəkədə Stats-da **TURN relay** görünürsə, TURN işləyir. TURN-u müvəqqəti söndürüb (`.env`-də `PR_TURN_URLS=`) eyni şəbəkədə sınayın → bəzi şəbəkələrdə qoşulma alınmamalıdır (TURN-un lazım olduğunu sübut edir).

## G. İcazələr və ləğv (acceptance 8)
- [ ] PC-də cihazı "Make view-only" → telefonda düymələr deaktiv, klik işləmir; "Allow control" → dərhal işləyir.
- [ ] "Trust unattended" → növbəti qoşulma təsdiqsiz; söndürün → yenə təsdiq.
- [ ] "Disconnect phone" → sessiya bitir.
- [ ] "Revoke" → telefon "Access revoked", yenidən qoşulmur; yeni pairing lazımdır.
- [ ] "Stop remote access" → telefon "PC offline"; server loglarında host offline.

## H. Gizlilik
- [ ] Server və companion loglarında (`docker compose logs signal`, companion stderr) 8 rəqəmli kod, token, SDP **yoxdur**.
