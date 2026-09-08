package com.cipher.manager

import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

/**
 * Blocking one-shot HTTP. Returns the body, or null for any failure — the
 * widgets treat null as "keep showing the cache". Use getStatus when the
 * status code itself carries meaning.
 *
 * No Origin header is sent: serve's CSRF guard refuses cross-origin /api
 * POSTs but lets header-less requests through.
 */
object Http {
    private const val TIMEOUT_MS = 6000

    fun get(url: String, bearer: String?, timeoutMs: Int = TIMEOUT_MS): String? =
        getStatus(url, bearer, timeoutMs).second

    /**
     * GET, keeping the status code.
     *
     * A caller that must tell "the PC is down" from "the PC refused you" needs
     * this: 401 on the g2 facade means the desktop revoked this client, which
     * is permanent, while a transport failure is not. Collapsing both to null
     * makes a revoked widget age its cache forever instead of asking to pair.
     *
     * Status is 0 when the request never completed.
     */
    fun getStatus(url: String, bearer: String?, timeoutMs: Int = TIMEOUT_MS): Pair<Int, String?> =
        call("GET", url, null, bearer, timeoutMs)

    fun post(url: String, body: String, bearer: String?, timeoutMs: Int = TIMEOUT_MS): String? =
        call("POST", url, body, bearer, timeoutMs).second

    private fun call(
        method: String,
        url: String,
        body: String?,
        bearer: String?,
        timeoutMs: Int,
    ): Pair<Int, String?> {
        var conn: HttpURLConnection? = null
        return try {
            val c = URL(url).openConnection() as HttpURLConnection
            conn = c
            c.requestMethod = method
            c.connectTimeout = timeoutMs
            c.readTimeout = timeoutMs
            if (!bearer.isNullOrEmpty()) c.setRequestProperty("Authorization", "Bearer $bearer")
            if (body != null) {
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json")
                OutputStreamWriter(c.outputStream).use { it.write(body) }
            }
            val code = c.responseCode
            val ok = code in 200..299
            val text = (if (ok) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() }
            code to (if (ok) text else null)
        } catch (e: Exception) {
            0 to null
        } finally {
            conn?.disconnect()
        }
    }
}
