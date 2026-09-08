package com.cipher.manager

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.SystemClock
import android.view.View
import android.widget.RemoteViews

/**
 * Shared data layer for both home-screen widgets: one fetch per refresh, cached
 * in the app's own SharedPreferences, rendered into every placed widget.
 *
 * Reads go to the G2 facade with the paired token; the app's own tokenized URL
 * is only used for actions (Task 6).
 */
object Widgets {
    const val ACTION_REFRESH = "com.cipher.manager.WIDGET_REFRESH"
    const val ACTION_PAGE = "com.cipher.manager.WIDGET_PAGE"
    const val ACTION_RUN_SKILL = "com.cipher.manager.WIDGET_RUN_SKILL"

    // A foreground broadcast's goAsync budget is ~10s, so 7s of network leaves
    // room for the parse and render before the process gets killed.
    private const val REFRESH_BUDGET_MS = 7000L

    private fun prefs(ctx: Context) = ctx.getSharedPreferences("cipher", Context.MODE_PRIVATE)

    /**
     * Drop everything the pairing granted, so both widgets fall back to their
     * unpaired copy. The caches go too: renderNextUp paints a countdown
     * whenever cacheNow holds an event, without consulting `paired`, so
     * keeping them would leave a revoked widget ticking toward a stale meeting.
     */
    private fun forgetPairing(p: SharedPreferences) {
        p.edit()
            .remove("g2Token")
            .remove("cacheNow")
            .remove("cacheBrief")
            .remove("briefPage")
            .apply()
    }

    /** Parses a cached GET /api/g2/brief payload into pages; empty on absence or corruption. */
    private fun parseCachedBrief(json: String?): List<String> =
        json?.let { runCatching { parseBrief(it) }.getOrNull() }.orEmpty()

    /** Fire a refresh from anywhere, including the main thread. */
    fun requestRefresh(ctx: Context) {
        // onResume calls this on every app launch, so skip the three legs
        // entirely when there is nothing on the home screen to paint.
        if (!anyPlaced(ctx)) return
        ctx.sendBroadcast(Intent(ctx, NextUpWidget::class.java).setAction(ACTION_REFRESH))
    }

    private fun anyPlaced(ctx: Context): Boolean {
        val mgr = AppWidgetManager.getInstance(ctx)
        return mgr.getAppWidgetIds(ComponentName(ctx, NextUpWidget::class.java)).isNotEmpty() ||
            mgr.getAppWidgetIds(ComponentName(ctx, TodayWidget::class.java)).isNotEmpty()
    }

    /** Blocking fetch + render. Callers must already be off the main thread. */
    fun refreshBlocking(ctx: Context) {
        val p = prefs(ctx)
        val saved = p.getString("url", "") ?: ""
        val base = serverBase(saved)
        val g2 = p.getString("g2Token", null)
        val deadline = SystemClock.elapsedRealtime() + REFRESH_BUDGET_MS
        // Every network leg goes through leg(): null means the budget is spent,
        // so a new leg that forgets the guard is a visible omission, not a
        // silent 6s addition to the total.
        fun leg() = legTimeoutMs(deadline, SystemClock.elapsedRealtime()).takeIf { it > 0 }
        if (base.isNotEmpty() && !g2.isNullOrEmpty()) {
            // A failed or skipped leg leaves the previous cache in place on
            // purpose — a stale value with an age stamp beats a blank widget.
            // 401 is the exception: that is the desktop revoking this client,
            // and it will never succeed again, so ageing the cache forever
            // would leave a dead widget counting down to a stale meeting.
            leg()?.let { t ->
                val (code, body) = Http.getStatus("$base/api/g2/now", g2, t)
                if (isRevoked(code)) forgetPairing(p)
                body?.let { p.edit().putString("cacheNow", it).apply() }
            }
            leg()?.let { t ->
                val (code, body) = Http.getStatus("$base/api/g2/brief", g2, t)
                if (isRevoked(code)) forgetPairing(p)
                body?.let { p.edit().putString("cacheBrief", it).apply() }
            }
        }
        if (base.isNotEmpty()) {
            leg()?.let { t ->
                Http.post("$base/api/load_app_state", """{"key":"settings"}""", tokenOf(saved), t)
                    ?.let { p.edit().putBoolean("actingMode", parseActingMode(it)).apply() }
            }
        }
        p.edit().remove("skillState").apply()
        render(ctx)
    }

    /**
     * Fire the configured skill on the PC. Blocking; callers must be off the
     * main thread.
     *
     * Re-reads acting mode from the server rather than trusting the cached
     * flag: serve does not enforce that gate, and the cache can be up to a
     * refresh period behind the desktop's actual setting. A read that fails
     * refuses the run.
     */
    fun runSkillBlocking(ctx: Context) {
        val p = prefs(ctx)
        val id = p.getString("widgetSkillId", null) ?: return
        val name = p.getString("widgetSkillName", id) ?: id
        val saved = p.getString("url", "") ?: ""
        val base = serverBase(saved)
        if (base.isEmpty()) return
        // This also runs inside a goAsync() window, and Http applies its
        // timeout to connect and read separately, so the default 6000 would
        // allow ~12s on a single call. Same leg() rule as refreshBlocking.
        val deadline = SystemClock.elapsedRealtime() + REFRESH_BUDGET_MS
        fun leg() = legTimeoutMs(deadline, SystemClock.elapsedRealtime()).takeIf { it > 0 }

        // The live gate. A null body (unreachable, non-2xx, budget spent) is not
        // permission, so the run is refused rather than fired on a stale cache.
        val settings = leg()?.let { t ->
            Http.post("$base/api/load_app_state", """{"key":"settings"}""", tokenOf(saved), t)
        }
        val acting = mayRun(settings)
        // Only a real answer updates the cache. Writing false for a read that
        // never happened would state something about the desktop's setting that
        // we did not learn, disarm the button until the next refresh, and break
        // the rule refreshBlocking states above: a failed leg keeps its cache.
        if (settings != null) p.edit().putBoolean("actingMode", acting).apply()
        if (!acting) {
            // No "refused" state: a real `false` also writes actingMode=false
            // just above, and renderToday's !acting branch already labels that
            // correctly. A second state on the identical condition would be
            // dead, and would contradict the button's colour if a concurrent
            // refresh landed actingMode=true between the two writes.
            if (settings == null) p.edit().putString("skillState", "offline").apply()
            else p.edit().remove("skillState").apply()
            render(ctx)
            return
        }

        val body = org.json.JSONObject()
            .put("skill", id)
            .put("label", name)
            .put("prompt", "Use the \"$name\" skill.\n\n")
            .toString()
        val started = leg()?.let { t ->
            Http.post("$base/api/run_skill", body, tokenOf(saved), t)
        } != null
        p.edit().putString("skillState", if (started) "started" else "failed").apply()
        render(ctx)
    }

    /** A PendingIntent that opens MainActivity on an SPA route. */
    private fun pendingRoute(ctx: Context, route: String, requestCode: Int): PendingIntent =
        PendingIntent.getActivity(
            ctx,
            requestCode,
            Intent(ctx, MainActivity::class.java)
                .setAction(Intent.ACTION_VIEW) // distinct action so extras aren't collapsed
                .putExtra("route", route)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    /**
     * A PendingIntent that broadcasts `action` back to whichever receiver owns
     * it — ACTION_REFRESH is NextUpWidget's (it refreshes both widgets), every
     * other widget action belongs to TodayWidget.
     */
    fun pendingSelf(ctx: Context, action: String, requestCode: Int): PendingIntent {
        val target = if (action == ACTION_REFRESH) NextUpWidget::class.java else TodayWidget::class.java
        return PendingIntent.getBroadcast(
            ctx,
            requestCode,
            Intent(ctx, target).setAction(action),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    fun render(ctx: Context) {
        val mgr = AppWidgetManager.getInstance(ctx)
        renderNextUp(ctx, mgr)
        renderToday(ctx, mgr)
    }

    private fun renderNextUp(ctx: Context, mgr: AppWidgetManager) {
        val ids = mgr.getAppWidgetIds(ComponentName(ctx, NextUpWidget::class.java))
        if (ids.isEmpty()) return
        val p = prefs(ctx)
        val now = p.getString("cacheNow", null)?.let { runCatching { parseNow(it) }.getOrNull() }
        val paired = !p.getString("g2Token", null).isNullOrEmpty()

        val v = RemoteViews(ctx.packageName, R.layout.widget_next_up)
        val eventMs = now?.eventMs
        if (eventMs != null) {
            v.setViewVisibility(R.id.countdown, View.VISIBLE)
            v.setChronometer(
                R.id.countdown,
                chronometerBase(eventMs, System.currentTimeMillis(), SystemClock.elapsedRealtime()),
                null,
                true,
            )
            v.setChronometerCountDown(R.id.countdown, true)
            v.setTextViewText(R.id.title, now?.eventTitle ?: "")
        } else {
            v.setViewVisibility(R.id.countdown, View.GONE)
            v.setTextViewText(
                R.id.title,
                when {
                    !paired -> "Pair in the app"
                    now == null -> "Not connected"
                    else -> "Nothing left today"
                },
            )
        }
        // Whole row opens the deck — the right destination whether it's showing
        // a countdown, "pair me", or nothing. Refresh lives on Today's header.
        v.setOnClickPendingIntent(R.id.root, pendingRoute(ctx, "deck", 2))
        mgr.updateAppWidget(ids, v)
    }

    private fun renderToday(ctx: Context, mgr: AppWidgetManager) {
        val ids = mgr.getAppWidgetIds(ComponentName(ctx, TodayWidget::class.java))
        if (ids.isEmpty()) return
        // One RemoteViews per id, because the line cap depends on how tall the
        // user made THIS widget and two placed Today widgets can differ. It has
        // to be a fresh object each time: RemoteViews setters APPEND actions
        // rather than replace them, so reusing one would leave every widget
        // showing the last id's line count.
        for (id in ids) {
            val h = mgr.getAppWidgetOptions(id)
                .getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 110)
            mgr.updateAppWidget(id, todayViews(ctx, bodyMaxLines(h)))
        }
    }

    private fun todayViews(ctx: Context, maxLines: Int): RemoteViews {
        val p = prefs(ctx)
        val paired = !p.getString("g2Token", null).isNullOrEmpty()
        val briefJson = p.getString("cacheBrief", null)
        val pages = parseCachedBrief(briefJson)
        val now = p.getString("cacheNow", null)?.let { runCatching { parseNow(it) }.getOrNull() }
        // Stamped from the brief's own ts, not "now"'s — the body below renders
        // the brief, and the two legs are cached (and can go stale) independently.
        val ts = briefTs(briefJson ?: "")

        val v = RemoteViews(ctx.packageName, R.layout.widget_today)
        v.setInt(R.id.body, "setMaxLines", maxLines)
        v.setTextViewText(
            R.id.body,
            when {
                !paired -> "Pair the widget from the app's Back menu."
                briefJson == null -> "No data yet — tap the header to refresh."
                pages.isEmpty() -> "Nothing to show right now."
                else -> pages[clampPageIndex(p.getInt("briefPage", 0), pages.size)]
            },
        )
        val stamp = when {
            briefJson == null -> "Not connected"
            // We hold a brief but no ts for it: a server too old to send one.
            // Saying "Not connected" here would be false — we have the data.
            ts <= 0 -> "age unknown"
            // != true, not == false: a missing cacheNow means deck liveness is
            // unknown, and the qualifier is the conservative reading.
            now?.deckLive != true -> "deck cache — ${ageLabel(ts, System.currentTimeMillis())}"
            else -> ageLabel(ts, System.currentTimeMillis())
        }
        v.setTextViewText(R.id.stamp, stamp)
        v.setOnClickPendingIntent(R.id.stamp, pendingSelf(ctx, ACTION_REFRESH, 0))
        v.setOnClickPendingIntent(R.id.body, pendingSelf(ctx, ACTION_PAGE, 1))
        v.setOnClickPendingIntent(R.id.actionDeck, pendingRoute(ctx, "deck", 2))
        v.setOnClickPendingIntent(R.id.actionAsk, pendingRoute(ctx, "ask", 3))
        val acting = p.getBoolean("actingMode", false)
        val skillName = p.getString("widgetSkillName", null)
        val skillState = p.getString("skillState", "")
        v.setTextViewText(
            R.id.actionSkill,
            when {
                skillName == null -> "Pick skill"
                !acting -> "Acting off"
                skillState == "started" -> "Started ✓"
                skillState == "failed" -> "Failed ✗"
                // The gate re-check never answered, so the cache is untouched
                // and still says yes. Saying "Acting off" would be a guess.
                skillState == "offline" -> "No answer"
                else -> "Run $skillName"
            },
        )
        // "Started ✓" stays until the next refresh, so leaving it armed means a
        // second tap silently fires a second job. Retry belongs on a failure,
        // not on a success.
        val armed = acting && skillName != null && skillState != "started"
        v.setTextColor(R.id.actionSkill, if (armed) 0xFF7DD3FC.toInt() else 0xFF6B7280.toInt())
        if (armed) {
            v.setOnClickPendingIntent(R.id.actionSkill, pendingSelf(ctx, ACTION_RUN_SKILL, 4))
        } else {
            v.setOnClickPendingIntent(R.id.actionSkill, pendingRoute(ctx, "skills", 5))
        }
        return v
    }

    /** Advance the brief to its next page, wrapping. */
    fun nextPage(ctx: Context) {
        val p = prefs(ctx)
        val pages = parseCachedBrief(p.getString("cacheBrief", null))
        if (pages.isEmpty()) return
        p.edit().putInt("briefPage", nextPageIndex(p.getInt("briefPage", 0), pages.size)).apply()
        render(ctx)
    }
}

/**
 * The countdown widget. It also owns the shared refresh broadcast, so both
 * widget types update from one fetch.
 */
class NextUpWidget : AppWidgetProvider() {

    override fun onUpdate(ctx: Context, mgr: AppWidgetManager, ids: IntArray) {
        backgroundRefresh(ctx)
    }

    override fun onReceive(ctx: Context, intent: Intent) {
        super.onReceive(ctx, intent)
        if (intent.action == Widgets.ACTION_REFRESH) backgroundRefresh(ctx)
    }

    private fun backgroundRefresh(ctx: Context) {
        // Paint what we already know BEFORE the network. Android does not
        // persist RemoteViews, so on first placement and after every reboot
        // the host shows initialLayout — empty TextViews and a dead 00:00 —
        // until the fetch returns, which with the PC unreachable is the full
        // budget. Cheap binder call; the fetch repaints over it.
        Widgets.render(ctx)
        // goAsync keeps the process alive for the fetch, which is bounded by
        // REFRESH_BUDGET_MS; a bare thread can be killed the moment onReceive
        // returns.
        val pending = goAsync()
        Thread {
            try {
                Widgets.refreshBlocking(ctx)
            } finally {
                pending.finish()
            }
        }.start()
    }
}

/** The brief + actions widget. Refresh is owned by NextUpWidget. */
class TodayWidget : AppWidgetProvider() {

    override fun onUpdate(ctx: Context, mgr: AppWidgetManager, ids: IntArray) {
        Widgets.requestRefresh(ctx)
    }

    /** Resized: re-render locally so the brief uses the new height. No fetch. */
    override fun onAppWidgetOptionsChanged(
        ctx: Context,
        mgr: AppWidgetManager,
        id: Int,
        newOptions: android.os.Bundle,
    ) {
        Widgets.render(ctx)
    }

    override fun onReceive(ctx: Context, intent: Intent) {
        super.onReceive(ctx, intent)
        when (intent.action) {
            Widgets.ACTION_PAGE -> Widgets.nextPage(ctx)
            Widgets.ACTION_RUN_SKILL -> {
                val pending = goAsync()
                Thread {
                    try {
                        Widgets.runSkillBlocking(ctx)
                    } finally {
                        pending.finish()
                    }
                }.start()
            }
        }
    }
}
