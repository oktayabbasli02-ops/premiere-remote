package com.premiereremote.app

import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.premiereremote.app.data.CredentialStore
import com.premiereremote.app.data.PairedHost
import com.premiereremote.app.input.NPoint
import com.premiereremote.app.net.PairResult
import com.premiereremote.app.net.PairingApi
import com.premiereremote.app.protocol.Protocol
import com.premiereremote.app.rtc.Rtc
import com.premiereremote.app.session.Phase
import com.premiereremote.app.session.RemoteController
import com.premiereremote.app.session.UiState
import com.premiereremote.app.ui.JogWheel
import com.premiereremote.app.ui.RemoteInput
import com.premiereremote.app.ui.RemoteSurface
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject

class MainActivity : ComponentActivity() {
    private lateinit var store: CredentialStore
    private val deepLink = mutableStateOf<Pair<String, String>?>(null)
    private var controller: RemoteController? = null
    private var netCallback: ConnectivityManager.NetworkCallback? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = CredentialStore(this)
        Rtc.init(this)
        handleIntent(intent)
        netCallback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) { controller?.onNetworkChanged() }
        }
        getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(netCallback!!)

        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                Surface(Modifier.fillMaxSize(), color = Color(0xFF141417)) {
                    App()
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        val uri = intent?.data ?: return
        if (uri.scheme == "premiereremote" && uri.host == "pair") {
            val s = uri.getQueryParameter("s").orEmpty()
            val c = uri.getQueryParameter("c").orEmpty()
            if (s.startsWith("https://") || s.startsWith("http://10.0.2.2") || s.startsWith("http://127.0.0.1")) deepLink.value = s to c
        }
    }

    override fun onDestroy() {
        netCallback?.let { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) }
        controller?.stop()
        super.onDestroy()
    }

    // ------------------------------------------------------------------ navigation
    @Composable
    private fun App() {
        var screen by remember { mutableStateOf(if (store.hosts().isEmpty()) "pair" else "home") }
        var active by remember { mutableStateOf<PairedHost?>(null) }
        val link by deepLink
        LaunchedEffect(link) { if (link != null) screen = "pair" }

        when (screen) {
            "home" -> HomeScreen(onPair = { screen = "pair" }, onConnect = { active = it; screen = "session" })
            "pair" -> PairScreen(
                prefill = link,
                onDone = { deepLink.value = null; screen = "home" },
                onCancel = { deepLink.value = null; screen = if (store.hosts().isEmpty()) "pair" else "home" },
            )
            "session" -> active?.let { h ->
                SessionScreen(h, onExit = { screen = "home" })
            }
        }
    }

    // ------------------------------------------------------------------ home
    @Composable
    private fun HomeScreen(onPair: () -> Unit, onConnect: (PairedHost) -> Unit) {
        var hosts by remember { mutableStateOf(store.hosts()) }
        Column(Modifier.fillMaxSize().safeDrawingPadding().padding(16.dp)) {
            Text("Premiere Remote", fontSize = 24.sp, color = Color.White)
            Text("Your device key ID: ${Protocol.keyHash(store.devicePublicKeySpki())}", color = Color.Gray, fontSize = 13.sp)
            Spacer(Modifier.height(16.dp))
            hosts.forEach { h ->
                Card(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                    Column(Modifier.padding(12.dp)) {
                        Text(h.hostName, fontSize = 18.sp)
                        Text("${h.serverUrl} · ${if (h.canControl) "view + control" else "view only"}", color = Color.Gray, fontSize = 12.sp)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
                            Button(onClick = { onConnect(h) }) { Text("Connect") }
                            TextButton(onClick = { store.forget(h.hostId); hosts = store.hosts() }) { Text("Forget") }
                        }
                    }
                }
            }
            Spacer(Modifier.height(12.dp))
            OutlinedButton(onClick = onPair) { Text("Pair a PC") }
        }
    }

    // ------------------------------------------------------------------ pairing
    @Composable
    private fun PairScreen(prefill: Pair<String, String>?, onDone: () -> Unit, onCancel: () -> Unit) {
        var server by remember(prefill) { mutableStateOf(prefill?.first ?: store.lastServerUrl) }
        var code by remember(prefill) { mutableStateOf(prefill?.second ?: "") }
        var name by remember { mutableStateOf("${Build.MANUFACTURER} ${Build.MODEL}".take(40)) }
        var status by remember { mutableStateOf("") }
        var busy by remember { mutableStateOf(false) }
        val scope = rememberCoroutineScope()
        val keyId = remember { Protocol.keyHash(store.devicePublicKeySpki()) }

        Column(Modifier.fillMaxSize().safeDrawingPadding().padding(16.dp).verticalScroll(rememberScrollState())) {
            Text("Pair with your PC", fontSize = 22.sp, color = Color.White)
            Text("On the PC: open the Premiere Remote panel → Enable remote access. Enter the 8-digit code shown there.", color = Color.Gray)
            Spacer(Modifier.height(12.dp))
            OutlinedTextField(server, { server = it.trim() }, label = { Text("Server URL (https://…)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(
                code, { v -> code = v.filter { it.isDigit() }.take(8) },
                label = { Text("8-digit code") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                textStyle = MaterialTheme.typography.headlineSmall.copy(fontFamily = FontFamily.Monospace),
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(name, { name = it.take(40) }, label = { Text("This phone's name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(8.dp))
            Text("Key ID: $keyId — the PC will show this; approve only if it matches.", color = Color(0xFFFFB547))
            Spacer(Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    enabled = !busy && Protocol.normalizeCode(code) != null && (server.startsWith("https://") || server.startsWith("http://10.0.2.2") || server.startsWith("http://127.0.0.1")),
                    onClick = {
                        busy = true
                        status = "Sending code…"
                        store.lastServerUrl = server
                        scope.launch {
                            val r = PairingApi().pair(server, Protocol.normalizeCode(code)!!, name, store.devicePublicKeySpki()) {
                                status = "Waiting for approval on the PC…"
                            }
                            busy = false
                            when (r) {
                                is PairResult.Approved -> {
                                    store.saveHost(PairedHost(r.hostId, r.hostName, server, r.deviceId, r.hostPublicKey, r.canControl), r.deviceToken)
                                    status = "Paired with ${r.hostName}."
                                    onDone()
                                }
                                is PairResult.Failed -> { status = r.reason; code = "" }
                            }
                        }
                    },
                ) { Text("Pair") }
                TextButton(onClick = onCancel) { Text("Cancel") }
            }
            Spacer(Modifier.height(8.dp))
            Text(status, color = Color.White)
        }
    }

    // ------------------------------------------------------------------ session
    @OptIn(ExperimentalLayoutApi::class)
    @Composable
    private fun SessionScreen(host: PairedHost, onExit: () -> Unit) {
        val surface = remember { RemoteSurface(this).also { it.video.init(Rtc.egl.eglBaseContext) } }
        val ctrl = remember { RemoteController(store, host, surface.video).also { controller = it; it.start() } }
        val ui by ctrl.ui.collectAsState()
        var trackpad by remember { mutableStateOf(false) }
        var showControls by remember { mutableStateOf(true) }
        var showStats by remember { mutableStateOf(false) }
        var showKeyboard by remember { mutableStateOf(false) }
        var precision by remember { mutableStateOf(false) }
        var menu by remember { mutableStateOf(false) }

        DisposableEffect(Unit) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            surface.input = object : RemoteInput {
                override fun move(p: NPoint) { ctrl.pointerMove(p.x, p.y) }
                override fun rel(dx: Float, dy: Float) { ctrl.pointerRel(dx, dy) }
                override fun pointer(kind: String, p: NPoint?, button: String, dy: Int) { ctrl.pointer(kind, p?.x, p?.y, button, dy) }
            }
            onDispose {
                window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                ctrl.stop()
                controller = null
                surface.video.release()
            }
        }
        surface.trackpad = trackpad
        surface.enabled2 = ui.canControl && ui.phase == Phase.LIVE

        Column(Modifier.fillMaxSize().safeDrawingPadding()) {
            // top bar
            Row(Modifier.fillMaxWidth().background(Color(0xFF1E1E22)).padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                PhaseChip(ui)
                Spacer(Modifier.width(6.dp))
                Text(ui.host.sequenceName ?: host.hostName, color = Color.White, fontSize = 13.sp, maxLines = 1, modifier = Modifier.weight(1f))
                FilterChip(selected = trackpad, onClick = { trackpad = !trackpad }, label = { Text(if (trackpad) "Trackpad" else "Touch") })
                TextButton(onClick = { showStats = !showStats }) { Text("Stats") }
                Box {
                    TextButton(onClick = { menu = true }) { Text("⋮") }
                    DropdownMenu(menu, { menu = false }) {
                        DropdownMenuItem(text = { Text("Capture: Premiere window") }, onClick = { ctrl.setCapture("window"); menu = false })
                        DropdownMenuItem(text = { Text("Capture: whole display (dialogs)") }, onClick = { ctrl.setCapture("display"); menu = false })
                        listOf("auto" to "Quality: Auto", "saver" to "540p (mobile data)", "responsive" to "720p30", "balanced" to "1080p30", "quality" to "1080p60").forEach { (id, l) ->
                            DropdownMenuItem(text = { Text(l) }, onClick = { ctrl.setQuality(id); menu = false })
                        }
                        DropdownMenuItem(text = { Text("Reset zoom") }, onClick = { surface.resetZoom(); menu = false })
                        DropdownMenuItem(text = { Text(if (showControls) "Hide edit controls" else "Show edit controls") }, onClick = { showControls = !showControls; menu = false })
                        DropdownMenuItem(text = { Text("Keyboard") }, onClick = { showKeyboard = true; menu = false })
                        DropdownMenuItem(text = { Text("Disconnect") }, onClick = { menu = false; onExit() })
                    }
                }
            }

            Box(Modifier.weight(1f).fillMaxWidth()) {
                AndroidView(factory = { surface }, modifier = Modifier.fillMaxSize())
                if (ui.phase != Phase.LIVE) {
                    Box(Modifier.align(Alignment.Center).background(Color(0xCC000000), RoundedCornerShape(8.dp)).padding(16.dp)) {
                        Text(ui.message.ifEmpty { ui.phase.name }, color = Color.White)
                    }
                }
                Column(Modifier.align(Alignment.TopStart).padding(6.dp)) {
                    if (ui.phase == Phase.LIVE) {
                        when {
                            !ui.host.premiereRunning -> Banner("Premiere is not running on the PC.")
                            ui.host.modal -> Banner("A dialog is open in Premiere. Switch capture to the whole display if you can't see it.")
                            !ui.host.foregroundIsPremiere && ui.host.foregroundTitle.isNotEmpty() -> Banner("Another window is in front: ${ui.host.foregroundTitle}")
                        }
                        if (ui.host.premiereRunning && !ui.host.pluginConnected) Banner("Premiere panel not open on the PC: API commands unavailable.")
                        if (ui.host.locked) Banner("Windows is locked on the PC. Input is paused.")
                        if (!ui.canControl) Banner("View-only access.")
                    }
                    ui.notices.forEach { Banner(it) }
                    if (ui.notices.isNotEmpty()) {
                        Box(Modifier.background(Color(0xCC000000), RoundedCornerShape(12.dp))) {
                            TextButton(onClick = { ctrl.dismissNotices() }) { Text("Dismiss") }
                        }
                    }
                }
                if (showStats) Box(Modifier.align(Alignment.BottomStart).padding(6.dp)) { StatsOverlay(ui) }
                var visibleAck by remember { mutableStateOf<Long?>(null) }
                LaunchedEffect(ui.lastAck?.at) {
                    visibleAck = ui.lastAck?.at
                    delay(4000)
                    visibleAck = null
                }
                ui.lastAck?.takeIf { it.at == visibleAck }?.let { ack ->
                    Box(Modifier.align(Alignment.BottomCenter).padding(8.dp).background(ackColor(ack.status, ack.verified), RoundedCornerShape(6.dp)).padding(horizontal = 12.dp, vertical = 6.dp)) {
                        Text(ack.message, color = Color.White, fontSize = 13.sp)
                    }
                }
            }

            if (showControls) EditControls(ui, ctrl, precision, onPrecision = { precision = !precision })
        }

        if (showKeyboard) KeyboardDialog(ctrl) { showKeyboard = false }
        if (ui.phase == Phase.REVOKED || ui.phase == Phase.SECURITY_ERROR) {
            AlertDialog(
                onDismissRequest = onExit,
                confirmButton = { TextButton(onClick = onExit) { Text("OK") } },
                title = { Text(if (ui.phase == Phase.REVOKED) "Access revoked" else "Security check failed") },
                text = { Text(ui.message) },
            )
        }
    }

    @Composable
    private fun PhaseChip(ui: UiState) {
        val (label, color) = when (ui.phase) {
            Phase.LIVE -> "LIVE" to Color(0xFF1B8A4B)
            Phase.RECONNECTING -> "RECONNECTING" to Color(0xFFB26A00)
            Phase.HOST_OFFLINE -> "PC OFFLINE" to Color(0xFF6B6B70)
            Phase.REVOKED, Phase.SECURITY_ERROR, Phase.REJECTED -> ui.phase.name to Color(0xFFC62828)
            else -> "CONNECTING" to Color(0xFF5B4CF0)
        }
        Box(Modifier.background(color, RoundedCornerShape(4.dp)).padding(horizontal = 6.dp, vertical = 2.dp)) {
            Text(label, color = Color.White, fontSize = 11.sp)
        }
    }

    @Composable
    private fun Banner(text: String) {
        Box(Modifier.padding(bottom = 4.dp).background(Color(0xDD5A4300), RoundedCornerShape(4.dp)).padding(horizontal = 8.dp, vertical = 4.dp)) {
            Text(text, color = Color(0xFFFFD57A), fontSize = 12.sp)
        }
    }

    @Composable
    private fun StatsOverlay(ui: UiState) {
        val s = ui.stats
        val lines = listOf(
            "Network RTT (ICE): ${s.rttMs?.let { "$it ms" } ?: "—"}",
            "App command RTT: ${ui.appRttMs?.let { "$it ms" } ?: "—"} (data channel + PC processing)",
            "End-to-end (glass-to-glass): not measured automatically",
            "Video: ${s.width ?: "?"}×${s.height ?: "?"} @ ${s.fps?.let { "%.0f".format(it) } ?: "?"} fps · ${s.bitrateKbps?.let { "$it kbit/s" } ?: "—"}",
            "Codec: ${s.codec ?: "?"} · decoder ${s.decoder ?: "?"} · PC encoder ${ui.host.hostEncoder ?: "?"}",
            "Loss: ${s.packetsLost ?: 0} pkts · jitter ${s.jitterMs?.let { "%.0f ms".format(it) } ?: "—"}",
            "Path: ${if (s.relayed == true) "TURN relay" else "direct"} (${s.candidates ?: "?"})",
            "Capture: ${ui.host.captureMode ?: "?"} ${ui.host.captureW ?: "?"}×${ui.host.captureH ?: "?"} · profile ${ui.host.quality ?: "?"}${if (ui.host.autoQuality) " (auto)" else ""}",
        )
        Column(Modifier.background(Color(0xB3000000), RoundedCornerShape(6.dp)).padding(6.dp)) {
            lines.forEach { Text(it, color = Color.White, fontSize = 9.sp, lineHeight = 11.sp, fontFamily = FontFamily.Monospace) }
        }
    }

    private fun ackColor(status: String, verified: Boolean) = when {
        status == "ok" && verified -> Color(0xEE1B8A4B)
        status == "ok" -> Color(0xEE3A3A80)
        else -> Color(0xEEC62828)
    }

    // ------------------------------------------------------------------ edit controls
    @OptIn(ExperimentalLayoutApi::class, ExperimentalFoundationApi::class)
    @Composable
    private fun EditControls(ui: UiState, ctrl: RemoteController, precision: Boolean, onPrecision: () -> Unit) {
        val caps = ui.capabilities.associateBy { it.action }
        val live = ui.phase == Phase.LIVE && ui.canControl
        var muteDialog by remember { mutableStateOf(false) }

        @Composable
        fun Cmd(action: String, label: String, args: JSONObject = JSONObject(), danger: Boolean = false, holdToConfirm: Boolean = false) {
            val c = caps[action] ?: return
            if (c.impl == "unsupported") return
            val colors = if (danger) ButtonDefaults.buttonColors(containerColor = Color(0xFF8E1B1B)) else ButtonDefaults.buttonColors()
            val suffix = if (c.impl == "keyboard") " ⌨" else ""
            if (holdToConfirm) {
                Box(
                    Modifier.padding(2.dp).heightIn(min = 44.dp).background(if (live) Color(0xFF8E1B1B) else Color.DarkGray, RoundedCornerShape(20.dp))
                        .combinedClickable(enabled = live, onClick = {}, onLongClick = { ctrl.command(action, label, args) })
                        .padding(horizontal = 14.dp, vertical = 12.dp),
                ) { Text("$label (hold)$suffix", color = Color.White, fontSize = 13.sp) }
            } else {
                Button(onClick = { ctrl.command(action, label, args) }, enabled = live, colors = colors, modifier = Modifier.padding(2.dp).heightIn(min = 44.dp)) {
                    Text(label + suffix, fontSize = 13.sp)
                }
            }
        }

        Row(Modifier.fillMaxWidth().background(Color(0xFF1E1E22)).padding(6.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f).heightIn(max = 260.dp).verticalScroll(rememberScrollState())) {
                FlowRow {
                    Cmd("goToStart", "|◀")
                    Cmd("stepFrames", "◀1", JSONObject().put("frames", -1))
                    Cmd("playPause", "▶/❚❚")
                    Cmd("stepFrames", "1▶", JSONObject().put("frames", 1))
                    Cmd("goToEnd", "▶|")
                }
                FlowRow {
                    Cmd("setIn", "In")
                    Cmd("setOut", "Out")
                    Cmd("addMarker", "Marker")
                    Cmd("addEdit", "Split")
                    Cmd("selectClipAtPlayhead", "Select")
                }
                FlowRow {
                    Cmd("deleteSelection", "Lift (gap)")
                    Cmd("rippleDeleteSelection", "Ripple delete", danger = true, holdToConfirm = true)
                    Cmd("trimPrevToPlayhead", "Trim ◀")
                    Cmd("trimNextToPlayhead", "Trim ▶")
                }
                FlowRow {
                    Cmd("zoomOut", "Zoom −")
                    Cmd("zoomIn", "Zoom +")
                    Cmd("undo", "Undo")
                    Cmd("redo", "Redo")
                    Cmd("save", "Save")
                    if (caps["trackMute"]?.impl == "api") OutlinedButton(onClick = { muteDialog = true }, enabled = live, modifier = Modifier.padding(2.dp)) { Text("Mute…") }
                }
                Text("⌨ = sent as a keyboard shortcut (result may be unverifiable)", color = Color.Gray, fontSize = 10.sp)
            }
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                JogWheel(size = 130.dp, precision = precision, enabled = live && caps["stepFrames"] != null) { frames ->
                    ctrl.command("stepFrames", "Jog ${if (frames > 0) "+" else ""}$frames", JSONObject().put("frames", frames))
                }
                TextButton(onClick = onPrecision) { Text(if (precision) "Precision ✓" else "Precision", fontSize = 12.sp) }
            }
        }

        if (muteDialog) {
            var kind by remember { mutableStateOf("audio") }
            var index by remember { mutableStateOf(0) }
            AlertDialog(
                onDismissRequest = { muteDialog = false },
                title = { Text("Track mute") },
                text = {
                    Column {
                        Row { listOf("audio", "video").forEach { k -> FilterChip(kind == k, { kind = k }, { Text(k) }, Modifier.padding(2.dp)) } }
                        FlowRow { (0 until 8).forEach { i -> FilterChip(index == i, { index = i }, { Text("${if (kind == "audio") "A" else "V"}${i + 1}") }, Modifier.padding(2.dp)) } }
                    }
                },
                confirmButton = {
                    Row {
                        TextButton(onClick = { ctrl.command("trackMute", "Mute ${kind[0].uppercase()}${index + 1}", JSONObject().put("kind", kind).put("index", index).put("mute", true)); muteDialog = false }) { Text("Mute") }
                        TextButton(onClick = { ctrl.command("trackMute", "Unmute ${kind[0].uppercase()}${index + 1}", JSONObject().put("kind", kind).put("index", index).put("mute", false)); muteDialog = false }) { Text("Unmute") }
                    }
                },
                dismissButton = { TextButton(onClick = { muteDialog = false }) { Text("Cancel") } },
            )
        }
    }

    @OptIn(ExperimentalLayoutApi::class)
    @Composable
    private fun KeyboardDialog(ctrl: RemoteController, onClose: () -> Unit) {
        var text by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = onClose,
            title = { Text("Keyboard") },
            text = {
                Column {
                    OutlinedTextField(text, { text = it.take(500) }, label = { Text("Text to type into Premiere") }, modifier = Modifier.fillMaxWidth())
                    FlowRow {
                        listOf("Esc" to "Escape", "Tab" to "Tab", "Enter" to "Enter", "⌫" to "Backspace", "Del" to "Delete", "←" to "Left", "→" to "Right", "↑" to "Up", "↓" to "Down", "Ctrl+A" to "Ctrl+A", "Ctrl+C" to "Ctrl+C", "Ctrl+V" to "Ctrl+V")
                            .forEach { (l, combo) -> OutlinedButton(onClick = { ctrl.key(combo) }, modifier = Modifier.padding(2.dp)) { Text(l) } }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { ctrl.text(text); text = "" }) { Text("Type") } },
            dismissButton = { TextButton(onClick = onClose) { Text("Close") } },
        )
    }
}
