package com.cipher.manager

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WidgetLogicTest {

    @Test
    fun serverBaseStripsQueryAndFragment() {
        assertEquals("http://192.168.1.50:4600", serverBase("http://192.168.1.50:4600/?token=abc"))
        assertEquals("https://desktop.tail1.ts.net", serverBase("https://desktop.tail1.ts.net/"))
        assertEquals("http://h:4600", serverBase("http://h:4600/?token=abc#/deck"))
        assertEquals("", serverBase(""))
    }

    @Test
    fun tokenOfReadsTheQueryTokenOrEmpty() {
        assertEquals("abc123", tokenOf("http://h:4600/?token=abc123"))
        assertEquals("abc123", tokenOf("http://h:4600/?foo=1&token=abc123#/deck"))
        assertEquals("", tokenOf("https://desktop.tail1.ts.net/"))
    }

    @Test
    fun deepLinkReplacesAnyExistingFragment() {
        assertEquals("http://h:4600/?token=abc#/deck", deepLink("http://h:4600/?token=abc", "deck"))
        assertEquals("http://h:4600/?token=abc#/ask", deepLink("http://h:4600/?token=abc#/deck", "ask"))
        assertEquals("http://h:4600/#/deck", deepLink("http://h:4600/", "/deck"))
    }

    @Test
    fun ageLabelBucketsByMagnitude() {
        val now = 1_000_000_000L
        assertEquals("now", ageLabel(now, now))
        assertEquals("now", ageLabel(now + 5_000, now)) // clock skew reads as fresh
        assertEquals("5m ago", ageLabel(now - 5 * 60_000, now))
        assertEquals("3h ago", ageLabel(now - 3 * 3_600_000, now))
        assertEquals("2d ago", ageLabel(now - 2 * 86_400_000L, now))
    }

    @Test
    fun chronometerBaseShiftsWallClockIntoElapsedRealtime() {
        // Event 10 minutes out, device up for 5 minutes: the base is 15 minutes
        // of uptime, so a counting-down Chronometer shows 10:00.
        assertEquals(900_000L, chronometerBase(600_000L, 0L, 300_000L))
    }

    @Test
    fun parseNowReadsTheDtoAndToleratesAnOlderServer() {
        val full = parseNow(
            """{"event":"in 23m Standup","eventMs":1700000000000,"eventTitle":"Standup",
               "overdue":2,"dueToday":3,"runningJobs":1,"deckLive":true,"ts":1699999999000}"""
        )
        assertEquals(1_700_000_000_000L, full.eventMs)
        assertEquals("Standup", full.eventTitle)
        assertEquals(2, full.overdue)
        assertEquals(3, full.dueToday)
        assertEquals(1, full.runningJobs)
        assertTrue(full.deckLive)

        // Server predating Task 1, and an explicit null when nothing is left today.
        assertNull(parseNow("""{"event":null,"overdue":0,"dueToday":0,"ts":1}""").eventMs)
        assertNull(parseNow("""{"eventMs":null,"eventTitle":null,"ts":1}""").eventTitle)
    }

    @Test
    fun parseBriefReturnsPagesInOrder() {
        assertEquals(
            listOf("TODAY\nStandup", "USAGE\n5h"),
            parseBrief("""{"pages":["TODAY\nStandup","USAGE\n5h"],"ts":1}""")
        )
        assertEquals(emptyList<String>(), parseBrief("""{"ts":1}"""))
    }

    @Test
    fun briefTsReadsThePresentValueOrZero() {
        assertEquals(1_700_000_000_000L, briefTs("""{"pages":[],"ts":1700000000000}"""))
        assertEquals(0L, briefTs("""{"pages":[]}""")) // absent
        assertEquals(0L, briefTs("not json")) // malformed
    }

    @Test
    fun nextPageIndexWrapsAtTheEnd() {
        assertEquals(0, nextPageIndex(2, 3)) // last page (index 2 of 3) wraps to first
        assertEquals(2, nextPageIndex(1, 3)) // otherwise just advances
    }

    @Test
    fun nextPageIndexClampsBeforeAdvancingWhenTheBriefShrank() {
        // The stored index (4) was chosen against a 5-page brief; a refresh
        // landed only 2 pages, and renderToday would clamp it to 1 for display.
        // Clamping first here — then advancing — lands on 0, not 1: advancing
        // off the page already on screen, not back onto it.
        assertEquals(0, nextPageIndex(4, 2))
    }

    @Test
    fun nextPageIndexClampsANegativeStoredIndex() {
        assertEquals(1, nextPageIndex(-1, 3))
    }

    @Test
    fun nextPageIndexReturnsZeroForEmptyOrInvalidSize() {
        assertEquals(0, nextPageIndex(0, 0))
        assertEquals(0, nextPageIndex(3, 0))
        assertEquals(0, nextPageIndex(3, -1))
    }

    @Test
    fun legTimeoutMsHalvesTheRemainingBudget() {
        assertEquals(5000, legTimeoutMs(10_000L, 0L))
        assertEquals(1000, legTimeoutMs(10_000L, 8_000L))
    }

    @Test
    fun legTimeoutMsReturnsZeroAtOrAfterTheDeadline() {
        assertEquals(0, legTimeoutMs(10_000L, 10_000L))
        assertEquals(0, legTimeoutMs(10_000L, 11_000L))
    }

    @Test
    fun legTimeoutMsReturnsZeroInsideThe250msFloor() {
        assertEquals(0, legTimeoutMs(10_499L, 10_000L)) // half = 249, below the floor
        assertEquals(250, legTimeoutMs(10_500L, 10_000L)) // half = 250, right at the floor
    }

    @Test
    fun parseActingModeUnwrapsTheDoubleEncodedAppState() {
        // load_app_state returns the stored blob as a JSON *string*, or null.
        assertTrue(parseActingMode("\"{\\\"actingMode\\\":true}\""))
        assertTrue(!parseActingMode("\"{\\\"actingMode\\\":false}\""))
        assertTrue(!parseActingMode("\"{}\""))
        assertTrue(!parseActingMode("null"))

        // Malformed or truncated bodies must fail closed, not throw: actingMode
        // gates execution.
        assertTrue(!parseActingMode(""))
        assertTrue(!parseActingMode("{"))
        assertTrue(!parseActingMode("\"abc"))
        assertTrue(!parseActingMode("[]"))
    }

    @Test
    fun mayRunTreatsNoAnswerAsNoPermission() {
        // The line that decides whether the widget may execute anything. serve
        // has no server-side actingMode check, so a null body — unreachable PC,
        // non-2xx, or the refresh budget already spent — must not read as yes.
        assertTrue(!mayRun(null))
        assertTrue(!mayRun(""))
        assertTrue(!mayRun("\"{\\\"actingMode\\\":false}\""))
        assertTrue(mayRun("\"{\\\"actingMode\\\":true}\""))
    }

    @Test
    fun onlyA401CountsAsRevoked() {
        // Revocation must be distinguishable from the PC merely being down: a
        // revoked token never succeeds again, so the widgets have to drop it
        // and ask to pair, while a transport failure keeps the cache.
        assertTrue(isRevoked(401))
        assertTrue(!isRevoked(0)) // never completed — offline, not refused
        assertTrue(!isRevoked(200))
        assertTrue(!isRevoked(403)) // serve uses 403 for CSRF, not revocation
        assertTrue(!isRevoked(500))
    }

    @Test
    fun bodyMaxLinesTracksTheWidgetHeight() {
        // 84dp of chrome (padding, stamp, margins, action row), 18dp per line.
        assertEquals(1, bodyMaxLines(110)) // declared 4x2 minimum: 26dp of body
        assertEquals(3, bodyMaxLines(150)) // typical 4x2 placement
        assertEquals(7, bodyMaxLines(220)) // dragged to 4x3

        // Never 0 — a widget too short to fit a line still shows one, clipped,
        // rather than a blank panel. And never unbounded on a huge cell.
        assertEquals(1, bodyMaxLines(0))
        assertEquals(1, bodyMaxLines(84))
        assertEquals(12, bodyMaxLines(4000))
    }
}
