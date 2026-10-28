package com.premiereremote.app.net

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

sealed class PairResult {
    data class Approved(
        val hostId: String, val hostName: String, val hostPublicKey: String,
        val deviceId: String, val deviceToken: String, val canControl: Boolean,
    ) : PairResult()
    data class Failed(val reason: String) : PairResult()
}

class PairingApi(private val http: OkHttpClient = OkHttpClient.Builder().readTimeout(40, TimeUnit.SECONDS).build()) {
    private val json = "application/json".toMediaType()

    private fun post(baseUrl: String, path: String, body: JSONObject): Pair<Int, JSONObject> {
        val req = Request.Builder().url(baseUrl.trimEnd('/') + path).post(body.toString().toRequestBody(json)).build()
        http.newCall(req).execute().use { r ->
            val text = r.body?.string().orEmpty()
            return r.code to (runCatching { JSONObject(text) }.getOrDefault(JSONObject()))
        }
    }

    /** Claims the 8-digit code, then long-polls until the PC owner approves or rejects. */
    suspend fun pair(
        baseUrl: String, code: String, deviceName: String, devicePublicKey: String,
        onWaiting: () -> Unit,
    ): PairResult = withContext(Dispatchers.IO) {
        val (status, claim) = try {
            post(baseUrl, "/v1/pair/claim", JSONObject().put("code", code).put("deviceName", deviceName).put("devicePublicKey", devicePublicKey))
        } catch (e: Exception) {
            return@withContext PairResult.Failed("Cannot reach server: ${e.message}")
        }
        when (status) {
            200 -> Unit
            404 -> return@withContext PairResult.Failed("Code is wrong, expired or already used. Generate a new code on the PC.")
            429 -> return@withContext PairResult.Failed("Too many attempts. Wait ${claim.optInt("retryAfterSec", 60)} s.")
            else -> return@withContext PairResult.Failed("Server error ($status)")
        }
        onWaiting()
        val waitBody = JSONObject().put("pairingId", claim.getString("pairingId")).put("pairingSecret", claim.getString("pairingSecret"))
        repeat(16) { // ~6 minutes of long polls; the server gives the host 5 minutes to decide
            val (s, r) = try {
                post(baseUrl, "/v1/pair/wait", waitBody)
            } catch (e: Exception) {
                return@withContext PairResult.Failed("Lost connection while waiting for approval: ${e.message}")
            }
            if (s != 200) return@withContext PairResult.Failed("Pairing request expired.")
            when (r.optString("status")) {
                "approved" -> return@withContext PairResult.Approved(
                    hostId = r.getString("hostId"),
                    hostName = r.optString("hostName", "PC"),
                    hostPublicKey = r.getString("hostPublicKey"),
                    deviceId = r.getString("deviceId"),
                    deviceToken = r.getString("deviceToken"),
                    canControl = r.optJSONObject("permissions")?.optBoolean("control", false) ?: false,
                )
                "rejected" -> return@withContext PairResult.Failed(
                    if (r.optString("reason") == "host_offline") "The PC is offline." else "The PC owner rejected the request.",
                )
                "expired" -> return@withContext PairResult.Failed("Pairing request expired.")
                else -> Unit // pending -> poll again
            }
        }
        PairResult.Failed("No decision from the PC.")
    }
}
