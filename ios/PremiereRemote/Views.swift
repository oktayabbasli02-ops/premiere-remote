import SwiftUI
import UIKit

@main
struct PremiereRemoteApp: App {
    var body: some Scene {
        WindowGroup { RootView().preferredColorScheme(.dark) }
    }
}

struct RootView: View {
    enum Screen: Equatable { case home, pair, session(PairedHost) }
    @State private var screen: Screen = Identity.shared.hosts().isEmpty ? .pair : .home
    @State private var prefill: (server: String, code: String)?

    var body: some View {
        Group {
            switch screen {
            case .home: HomeView(onPair: { screen = .pair }, onConnect: { screen = .session($0) })
            case .pair: PairView(prefillServer: prefill?.server, prefillCode: prefill?.code,
                                 onDone: { prefill = nil; screen = .home },
                                 onCancel: { prefill = nil; screen = Identity.shared.hosts().isEmpty ? .pair : .home })
            case .session(let h): SessionView(paired: h, onExit: { screen = .home })
            }
        }
        // premiereremote://pair?s=<https server>&c=<code> (handed over by the web page)
        .onOpenURL { url in
            guard url.scheme == "premiereremote", url.host == "pair",
                  let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
                  let s = q.first(where: { $0.name == "s" })?.value, s.hasPrefix("https://"),
                  let c = q.first(where: { $0.name == "c" })?.value else { return }
            prefill = (s, c)
            screen = .pair
        }
    }
}

struct HomeView: View {
    let onPair: () -> Void
    let onConnect: (PairedHost) -> Void
    @State private var hosts = Identity.shared.hosts()

    var body: some View {
        List {
            Section {
                Text("Your device key ID: \(Identity.shared.keyId)").font(.footnote).foregroundStyle(.secondary)
                if Identity.shared.usesSecureEnclave { Label("Key stored in the Secure Enclave", systemImage: "lock.shield").font(.footnote) }
            }
            ForEach(hosts) { h in
                VStack(alignment: .leading, spacing: 6) {
                    Text(h.hostName).font(.headline)
                    Text("\(h.serverUrl) · \(h.canControl ? "view + control" : "view only")").font(.caption).foregroundStyle(.secondary)
                    HStack {
                        Button("Connect") { onConnect(h) }.buttonStyle(.borderedProminent)
                        Button("Forget", role: .destructive) { Identity.shared.forget(hostId: h.hostId); hosts = Identity.shared.hosts() }
                    }
                }
            }
            Button("Pair a PC", action: onPair)
        }
        .navigationTitle("Premiere Remote")
    }
}

struct PairView: View {
    let prefillServer: String?
    let prefillCode: String?
    let onDone: () -> Void
    let onCancel: () -> Void
    @State private var server = ""
    @State private var code = ""
    @State private var name = UIDevice.current.name
    @State private var status = ""
    @State private var busy = false

    private var serverOk: Bool { server.hasPrefix("https://") || server.hasPrefix("http://127.0.0.1") || server.hasPrefix("http://localhost") }

    var body: some View {
        Form {
            Section(footer: Text("On the PC: open the Premiere Remote panel → Enable remote access.")) {
                TextField("Server URL (https://…)", text: $server).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                TextField("8-digit code", text: $code).keyboardType(.numberPad).font(.system(.title2, design: .monospaced))
                    .onChange(of: code) { v in code = String(v.filter(\.isNumber).prefix(8)) }
                TextField("This device's name", text: $name)
            }
            Section {
                Text("Key ID: \(Identity.shared.keyId) — the PC will show this; approve only if it matches.").foregroundStyle(.orange)
                Button(busy ? "Waiting…" : "Pair") { pair() }.disabled(busy || PRProtocol.normalizeCode(code) == nil || !serverOk)
                Button("Cancel", role: .cancel, action: onCancel)
                if !status.isEmpty { Text(status) }
            }
        }
        .onAppear {
            server = prefillServer ?? Identity.shared.lastServerUrl
            code = prefillCode ?? ""
        }
    }

    private func pair() {
        busy = true
        status = "Sending code…"
        Identity.shared.lastServerUrl = server
        Task {
            let r = await PairingAPI().pair(server: server, code: PRProtocol.normalizeCode(code) ?? "", deviceName: name) { status = "Waiting for approval on the PC…" }
            busy = false
            switch r {
            case .approved(let h, let token):
                Identity.shared.save(host: h, deviceToken: token)
                onDone()
            case .failed(let reason):
                status = reason
                code = ""
            }
        }
    }
}

@MainActor
struct SessionView: View {
    let paired: PairedHost
    let onExit: () -> Void
    @StateObject private var ctrl: RemoteController
    private let surface: RemoteVideoUIView
    @Environment(\.scenePhase) private var scenePhase
    @State private var trackpad = false
    @State private var showStats = false
    @State private var showControls = true
    @State private var precision = false
    @State private var showKeyboard = false
    @State private var visibleAck: AckInfo?

    init(paired: PairedHost, onExit: @escaping () -> Void) {
        self.paired = paired
        self.onExit = onExit
        let s = RemoteVideoUIView(frame: .zero)
        surface = s
        _ctrl = StateObject(wrappedValue: RemoteController(paired: paired, renderer: s.video))
    }

    var body: some View {
        VStack(spacing: 0) {
            topBar
            ZStack(alignment: .topLeading) {
                RemoteVideoView(uiView: surface)
                if ctrl.phase != .live {
                    Text(ctrl.message.isEmpty ? ctrl.phase.rawValue : ctrl.message)
                        .padding().background(.black.opacity(0.8)).cornerRadius(8).frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                banners.padding(6)
                if showStats { statsOverlay.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading).padding(6) }
                if let a = visibleAck {
                    Text(a.message).font(.footnote).padding(.horizontal, 12).padding(.vertical, 6)
                        .background(a.status == "ok" ? (a.verified ? Color.green : Color.indigo) : Color.red).cornerRadius(6)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom).padding(8)
                }
            }
            if showControls { EditControls(ctrl: ctrl, precision: $precision) }
        }
        .onAppear { wire(); ctrl.start() }
        .onDisappear { ctrl.stop() }
        .onChange(of: scenePhase) { p in if p == .active { ctrl.resume() } }
        .onChange(of: ctrl.lastAck) { a in
            visibleAck = a
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { if visibleAck == a { visibleAck = nil } }
        }
        .onChange(of: ctrl.phase) { _ in surface.controlEnabled = ctrl.phase == .live && ctrl.canControl }
        .onChange(of: ctrl.canControl) { _ in surface.controlEnabled = ctrl.phase == .live && ctrl.canControl }
        .onChange(of: trackpad) { v in surface.trackpad = v }
        .sheet(isPresented: $showKeyboard) { KeyboardSheet(ctrl: ctrl) }
        .alert(ctrl.phase == .revoked ? "Access revoked" : "Security check failed",
               isPresented: .constant(ctrl.phase == .revoked || ctrl.phase == .securityError)) {
            Button("OK", action: onExit)
        } message: { Text(ctrl.message) }
        .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
        .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
    }

    private func wire() {
        let c = ctrl
        surface.onMove = { [weak c] p in c?.move(p) }
        surface.onRel = { [weak c] dx, dy in c?.rel(dx: dx, dy: dy) }
        surface.onPointer = { [weak c] kind, p, button, dy in c?.pointer(kind, at: p, button: button, dy: dy) }
    }

    private var topBar: some View {
        HStack(spacing: 8) {
            Text(chipLabel).font(.caption2.bold()).padding(.horizontal, 6).padding(.vertical, 2).background(chipColor).cornerRadius(4)
            Text(ctrl.host.sequenceName ?? paired.hostName).font(.subheadline).lineLimit(1)
            Spacer()
            Toggle(trackpad ? "Trackpad" : "Touch", isOn: $trackpad).toggleStyle(.button)
            Button("Stats") { showStats.toggle() }
            Menu {
                Button("Capture: Premiere window") { ctrl.setCapture("window") }
                Button("Capture: whole display (dialogs)") { ctrl.setCapture("display") }
                ForEach([("auto", "Quality: Auto"), ("saver", "540p (mobile data)"), ("responsive", "720p30"), ("balanced", "1080p30"), ("quality", "1080p60")], id: \.0) { q in
                    Button(q.1) { ctrl.setQuality(q.0) }
                }
                Button("Reset zoom") { surface.resetZoom() }
                Button(showControls ? "Hide edit controls" : "Show edit controls") { showControls.toggle() }
                Button("Keyboard") { showKeyboard = true }
                Button("Disconnect", role: .destructive, action: onExit)
            } label: { Image(systemName: "ellipsis.circle") }
        }
        .padding(.horizontal, 8).padding(.vertical, 4).background(Color(white: 0.12))
    }

    private var chipLabel: String {
        switch ctrl.phase {
        case .live: return "LIVE"
        case .reconnecting: return "RECONNECTING"
        case .hostOffline: return "PC OFFLINE"
        case .revoked: return "REVOKED"
        case .securityError: return "SECURITY"
        case .rejected: return "REJECTED"
        default: return "CONNECTING"
        }
    }

    private var chipColor: Color {
        switch ctrl.phase {
        case .live: return .green
        case .reconnecting: return .orange
        case .revoked, .securityError, .rejected: return .red
        case .hostOffline: return .gray
        default: return .indigo
        }
    }

    @ViewBuilder private var banners: some View {
        VStack(alignment: .leading, spacing: 4) {
            if ctrl.phase == .live {
                if !ctrl.host.premiereRunning { banner("Premiere is not running on the PC.") }
                else if ctrl.host.modal { banner("A dialog is open in Premiere. Switch capture to the whole display if you can't see it.") }
                else if !ctrl.host.foregroundIsPremiere && !ctrl.host.foregroundTitle.isEmpty { banner("Another window is in front: \(ctrl.host.foregroundTitle)") }
                if ctrl.host.premiereRunning && !ctrl.host.pluginConnected { banner("Premiere panel not open on the PC: API commands unavailable.") }
                if ctrl.host.locked { banner("Windows is locked on the PC. Input is paused.") }
                if !ctrl.canControl { banner("View-only access.") }
            }
            ForEach(ctrl.notices, id: \.self) { banner($0) }
            if !ctrl.notices.isEmpty { Button("Dismiss") { ctrl.dismissNotices() }.font(.caption) }
        }
    }

    private func banner(_ t: String) -> some View {
        Text(t).font(.caption).foregroundStyle(Color(red: 1, green: 0.84, blue: 0.48))
            .padding(.horizontal, 8).padding(.vertical, 4).background(Color(red: 0.35, green: 0.26, blue: 0).opacity(0.92)).cornerRadius(4)
    }

    private var statsOverlay: some View {
        let s = ctrl.stats
        let lines = [
            "Network RTT (ICE): \(s.rttMs.map { "\($0) ms" } ?? "—")",
            "App command RTT: \(ctrl.appRttMs.map { "\($0) ms" } ?? "—") (data channel + PC processing)",
            "End-to-end (glass-to-glass): not measured automatically",
            "Video: \(s.width ?? 0)×\(s.height ?? 0) @ \(Int(s.fps ?? 0)) fps · \(s.bitrateKbps.map { "\($0) kbit/s" } ?? "—")",
            "Codec: \(s.codec ?? "?") · decoder \(s.decoder ?? "?") · PC encoder \(ctrl.host.hostEncoder ?? "?")",
            "Loss: \(s.packetsLost ?? 0) pkts · jitter \(s.jitterMs.map { "\(Int($0)) ms" } ?? "—")",
            "Path: \(s.relayed == true ? "TURN relay" : "direct") (\(s.candidates ?? "?"))",
        ]
        return VStack(alignment: .leading, spacing: 1) { ForEach(lines, id: \.self) { Text($0) } }
            .font(.system(size: 9, design: .monospaced)).padding(6).background(.black.opacity(0.7)).cornerRadius(6)
    }
}

struct EditControls: View {
    @ObservedObject var ctrl: RemoteController
    @Binding var precision: Bool
    @State private var showMute = false

    private let rows: [[(String, String, [String: Any])]] = [
        [("goToStart", "|◀", [:]), ("stepFrames", "◀1", ["frames": -1]), ("playPause", "▶/❚❚", [:]), ("stepFrames", "1▶", ["frames": 1]), ("goToEnd", "▶|", [:])],
        [("setIn", "In", [:]), ("setOut", "Out", [:]), ("addMarker", "Marker", [:]), ("addEdit", "Split", [:]), ("selectClipAtPlayhead", "Select", [:])],
        [("deleteSelection", "Lift (gap)", [:]), ("trimPrevToPlayhead", "Trim ◀", [:]), ("trimNextToPlayhead", "Trim ▶", [:])],
        [("zoomOut", "Zoom −", [:]), ("zoomIn", "Zoom +", [:]), ("undo", "Undo", [:]), ("redo", "Redo", [:]), ("save", "Save", [:])],
    ]

    private var live: Bool { ctrl.phase == .live && ctrl.canControl }
    private func cap(_ a: String) -> Capability? { ctrl.capabilities.first { $0.action == a && $0.impl != "unsupported" } }

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(rows.indices, id: \.self) { r in
                        FlowRow {
                            ForEach(rows[r].indices, id: \.self) { i in
                                let (action, label, args) = rows[r][i]
                                if let c = cap(action) {
                                    Button(label + (c.impl == "keyboard" ? " ⌨" : "")) { ctrl.command(action, label: label, args: args) }
                                        .buttonStyle(.borderedProminent).disabled(!live)
                                }
                            }
                            if r == 2, cap("rippleDeleteSelection") != nil {
                                // destructive: needs a deliberate long press
                                Text("Ripple delete (hold)").padding(.horizontal, 12).padding(.vertical, 8)
                                    .background(live ? Color.red.opacity(0.8) : Color.gray).foregroundStyle(.white).cornerRadius(16)
                                    .onLongPressGesture(minimumDuration: 0.6) { if live { ctrl.command("rippleDeleteSelection", label: "Ripple delete") } }
                            }
                            if r == 3, cap("trackMute")?.impl == "api" {
                                Button("Mute…") { showMute = true }.buttonStyle(.bordered).disabled(!live)
                            }
                        }
                    }
                    Text("⌨ = sent as a keyboard shortcut (result may be unverifiable)").font(.system(size: 10)).foregroundStyle(.secondary)
                }
            }
            .frame(maxHeight: 250)
            VStack {
                JogWheel(precision: precision, enabled: live && cap("stepFrames") != nil) { n in
                    ctrl.command("stepFrames", label: "Jog \(n > 0 ? "+" : "")\(n)", args: ["frames": n])
                }
                .frame(width: 120, height: 120)
                Button(precision ? "Precision ✓" : "Precision") { precision.toggle() }.font(.caption)
            }
        }
        .padding(6)
        .background(Color(white: 0.12))
        .confirmationDialog("Track mute", isPresented: $showMute) {
            ForEach(0..<4) { i in
                Button("Mute A\(i + 1)") { ctrl.command("trackMute", label: "Mute A\(i + 1)", args: ["kind": "audio", "index": i, "mute": true]) }
                Button("Unmute A\(i + 1)") { ctrl.command("trackMute", label: "Unmute A\(i + 1)", args: ["kind": "audio", "index": i, "mute": false]) }
            }
        }
    }
}

/// Wrapping row of buttons.
struct FlowRow: Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0
        for s in subviews {
            let sz = s.sizeThatFits(.unspecified)
            if x + sz.width > width, x > 0 { x = 0; y += rowH + 4; rowH = 0 }
            x += sz.width + 4
            rowH = max(rowH, sz.height)
        }
        return CGSize(width: width == .infinity ? x : width, height: y + rowH)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowH: CGFloat = 0
        for s in subviews {
            let sz = s.sizeThatFits(.unspecified)
            if x + sz.width > bounds.maxX, x > bounds.minX { x = bounds.minX; y += rowH + 4; rowH = 0 }
            s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(sz))
            x += sz.width + 4
            rowH = max(rowH, sz.height)
        }
    }
}

/// Jog wheel: clockwise = forward; frames are batched every 80 ms into one stepFrames command.
struct JogWheel: View {
    let precision: Bool
    let enabled: Bool
    let onFrames: (Int) -> Void
    @State private var angle: Double = 0
    @State private var last: Double?
    @State private var acc: Double = 0
    @State private var pending = 0
    private let timer = Timer.publish(every: 0.08, on: .main, in: .common).autoconnect()

    var body: some View {
        GeometryReader { geo in
            let c = CGPoint(x: geo.size.width / 2, y: geo.size.height / 2)
            ZStack {
                Circle().fill(Color(white: 0.17))
                Circle().stroke(precision ? Color.orange : Color.purple, lineWidth: 4).padding(3)
                ForEach(0..<24) { i in
                    // full-size frame so the rotation pivots on the wheel centre, not the tick
                    Rectangle().fill(Color.gray).frame(width: 2, height: 12)
                        .offset(y: -geo.size.width / 2 + 16)
                        .frame(width: geo.size.width, height: geo.size.height)
                        .rotationEffect(.degrees(angle + Double(i) * 15))
                }
                Circle().fill(Color(white: 0.27)).frame(width: geo.size.width * 0.56)
            }
            .contentShape(Circle())
            .gesture(DragGesture(minimumDistance: 0)
                .onChanged { v in
                    guard enabled else { return }
                    let a = atan2(v.location.y - c.y, v.location.x - c.x) * 180 / .pi
                    if let l = last {
                        var d = a - l
                        if d > 180 { d -= 360 }
                        if d < -180 { d += 360 }
                        angle += d
                        acc += d
                        let per = precision ? 30.0 : 8.0
                        let n = Int(acc / per)
                        if n != 0 { pending += n; acc -= Double(n) * per }
                    }
                    last = a
                }
                .onEnded { _ in last = nil })
        }
        .onReceive(timer) { _ in
            if pending != 0 { onFrames(max(-600, min(600, pending))); pending = 0 }
        }
    }
}

struct KeyboardSheet: View {
    @ObservedObject var ctrl: RemoteController
    @State private var text = ""
    @Environment(\.dismiss) private var dismiss
    private let keys = [("Esc", "Escape"), ("Tab", "Tab"), ("Enter", "Enter"), ("⌫", "Backspace"), ("Del", "Delete"),
                        ("←", "Left"), ("→", "Right"), ("↑", "Up"), ("↓", "Down"), ("Ctrl+A", "Ctrl+A"), ("Ctrl+C", "Ctrl+C"), ("Ctrl+V", "Ctrl+V")]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField("Text to type into Premiere", text: $text).textFieldStyle(.roundedBorder)
            FlowRow { ForEach(keys, id: \.1) { k in Button(k.0) { ctrl.key(k.1) }.buttonStyle(.bordered) } }
            HStack {
                Button("Type") { ctrl.text(text); text = "" }.buttonStyle(.borderedProminent)
                Button("Close") { dismiss() }
            }
            Spacer()
        }
        .padding()
        .presentationDetents([.medium])
    }
}
