package com.cipher.manager

import org.json.JSONObject
import org.json.JSONTokener

// Pure display/parsing logic for the home-screen widgets. No Android imports:
// this file is unit-tested on the JVM, and everything that touches the
// framework lives in Widgets.kt.

/** Scheme + host + port of the saved server URL, with no trailing slash. */
fun serverBase(savedUrl: String): String =
    savedUrl.substringBefore('#').substringBefore('?').trimEnd('/')

/** The `token` query parameter of the saved URL, or "" for a tokenless bind. */
fun tokenOf(savedUrl: String): String =
    savedUrl.substringBefore('#')
        .substringAfter('?', "")
        .split('&')
        .firstOrNull { it.startsWith("token=") }
        ?.removePrefix("token=")
        ?: ""

/** The saved URL pointed at an SPA route. HashRouter, so this never hits the server. */
fun deepLink(savedUrl: String, route: String): String =
    savedUrl.substringBefore('#') + "#/" + route.trimStart('/')

/** How stale a cached payload is, for the widget header. */
fun ageLabel(tsMs: Long, nowMs: Long): String {
    val s = (nowMs - tsMs) / 1000
    return when {
        s < 90 -> "now"
        s < 3600 -> "${s / 60}m ago"
        s < 86_400 -> "${s / 3600}h ago"
        else -> "${s / 86_400}d ago"
    }
}

/**
 * Chronometer counts in SystemClock.elapsedRealtime(), not wall clock, so a
 * wall-clock instant has to be shifted into that timebase before it can be a
 * countdown base.
 */
fun chronometerBase(eventMs: Long, nowMs: Long, elapsedRealtimeMs: Long): Long =
    elapsedRealtimeMs + (eventMs - nowMs)

data class NowData(
    val eventMs: Long?,
    val eventTitle: String?,
    val overdue: Int,
    val dueToday: Int,
    val runningJobs: Int,
    val deckLive: Boolean,
    val ts: Long,
)

/**
 * Per-phase timeout for the next network leg of a widget refresh, or 0 when
 * there is not enough budget left to bother.
 *
 * Halving what remains is what stops a stalled leg from starving the ones
 * after it: a leg that burns its whole slice leaves the next call returning 0,
 * so the leg count is bounded rather than each leg getting a fresh 6s.
 *
 * Not a hard wall-clock bound. readTimeout is SO_TIMEOUT, i.e. per blocking
 * read, and reading the status line and the body are separate reads, so a
 * server dribbling bytes just under the timeout can exceed the deadline. Fine
 * for small JSON with a Content-Length over a LAN or tailnet, where a dead
 * link stalls once and throws. A true bound would need a watchdog thread.
 */
fun legTimeoutMs(deadlineMs: Long, nowMs: Long): Int {
    val remaining = deadlineMs - nowMs
    val half = remaining / 2
    return if (half < 250) 0 else half.toInt()
}

/** Parses GET /api/g2/now. `isNull` also covers an absent key, i.e. an older server. */
fun parseNow(json: String): NowData {
    val o = JSONObject(json)
    return NowData(
        eventMs = if (o.isNull("eventMs")) null else o.getLong("eventMs"),
        eventTitle = if (o.isNull("eventTitle")) null else o.getString("eventTitle"),
        overdue = o.optInt("overdue"),
        dueToday = o.optInt("dueToday"),
        runningJobs = o.optInt("runningJobs"),
        deckLive = o.optBoolean("deckLive"),
        ts = o.optLong("ts"),
    )
}

/** Parses GET /api/g2/brief into its <=400-char pages. */
fun parseBrief(json: String): List<String> {
    val arr = JSONObject(json).optJSONArray("pages") ?: return emptyList()
    return (0 until arr.length()).map { arr.getString(it) }
}

/** The `ts` of a cached GET /api/g2/brief payload, or 0 when absent. */
fun briefTs(json: String): Long = runCatching { JSONObject(json).optLong("ts") }.getOrDefault(0L)

/** Clamps a stored page index into `[0, size)`; 0 when there are no pages. */
fun clampPageIndex(current: Int, size: Int): Int =
    if (size <= 0) 0 else current.coerceIn(0, size - 1)

/**
 * The next brief page, wrapping. Clamps first: a shorter brief than the one
 * the stored index was chosen against would otherwise advance to the page
 * already on screen, making the tap look dead.
 */
fun nextPageIndex(current: Int, size: Int): Int {
    if (size <= 0) return 0
    return (clampPageIndex(current, size) + 1) % size
}

/**
 * Parses POST /api/load_app_state {"key":"settings"} — which answers with the
 * stored blob as a JSON string (or null), so the payload is double-encoded.
 * Anything unparseable reads as "acting mode off", the safe default.
 */
fun parseActingMode(json: String): Boolean = runCatching {
    val inner = JSONTokener(json).nextValue() as? String ?: return@runCatching false
    JSONObject(inner).optBoolean("actingMode", false)
}.getOrDefault(false)

/**
 * Whether a run may proceed, given the raw body of a live settings read.
 *
 * The single line that decides whether the widget is allowed to execute
 * anything: serve does not enforce the acting-mode gate, so this does. A null
 * body — unreachable, non-2xx, or the refresh budget already spent — is not
 * permission. It lives here rather than inline so it can be pinned by a test;
 * flipping it to `?: true` would otherwise compile and ship green.
 */
fun mayRun(body: String?): Boolean = body?.let { parseActingMode(it) } ?: false

/**
 * Whether an HTTP status from the g2 facade means this client was revoked.
 *
 * The distinction the widgets live or die by: a transport failure is temporary
 * and the right answer is to keep showing the cache, but 401 is the desktop
 * having revoked the pairing and will never succeed again. Treating them alike
 * leaves a dead widget ageing a stale brief forever instead of asking to pair.
 * Status 0 is "never completed", which is the transport case, not a refusal.
 */
fun isRevoked(status: Int): Boolean = status == 401

/**
 * How many lines of the brief fit in a Today widget of this height.
 *
 * A TextView never reduces maxLines to fit its measured height — maxLines is
 * the only place it ellipsizes — so a fixed cap is wrong at every size but
 * one: too high and the text clips mid-word below the visible bounds, too low
 * and a widget the user dragged taller stays three lines with empty space
 * under it.
 *
 * widget_today.xml's chrome, at the current text sizes: 24dp padding + ~16dp
 * stamp + 6dp + 6dp margins + ~32dp action row (13sp text plus 8dp padding
 * each side). Body lines are 15sp at roughly 1.2x leading.
 */
fun bodyMaxLines(widgetHeightDp: Int): Int {
    val body = widgetHeightDp - TODAY_CHROME_DP
    return (body / TODAY_LINE_DP).coerceIn(1, 12)
}

private const val TODAY_CHROME_DP = 84
private const val TODAY_LINE_DP = 18
