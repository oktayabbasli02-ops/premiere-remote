package com.premiereremote.app.net

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Device-side signaling over WSS. Reconnects are driven by RemoteController (it owns the backoff)
 * so that a reconnect always starts a fresh session and never replays stale state.
 */
class SignalingClient(
    private val serverUrl: String,
    private val deviceId: String,
    private val token: String,
    private val listener: Listener,
) {
    interface Listener {
        fun onOpen()
        fun onMessage(msg: JSONObject)
        fun onClosed(code: Int, reason: String)
    }

    private val http = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()
    private var ws: WebSocket? = null

    fun connect() {
        val url = serverUrl.trimEnd('/').replaceFirst("https://", "wss://").replaceFirst("http://", "ws://") + "/v1/ws"
        ws = http.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(JSONObject().put("t", "hello").put("role", "device").put("deviceId", deviceId).put("token", token).toString())
                listener.onOpen()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                runCatching { JSONObject(text) }.getOrNull()?.let { listener.onMessage(it) }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = listener.onClosed(code, reason)

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) =
                listener.onClosed(-1, t.message ?: "network error")
        })
    }

    fun send(msg: JSONObject): Boolean = ws?.send(msg.toString()) ?: false

    fun close() {
        ws?.close(1000, "bye")
        ws = null
    }
}
