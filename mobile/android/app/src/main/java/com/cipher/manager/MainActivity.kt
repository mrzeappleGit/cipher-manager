package com.cipher.manager

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.widget.FrameLayout
import android.widget.TextView
import android.text.InputType
import android.webkit.HttpAuthHandler
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Toast
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.pm.PackageInfoCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Thin WebView wrapper around the cipherManager web server running on the PC.
 * All data and job execution live there; this is just the phone client.
 * The server URL (including ?token=…) is entered once and saved.
 */
class MainActivity : Activity() {

    private lateinit var web: WebView
    private val prefs by lazy { getSharedPreferences("cipher", MODE_PRIVATE) }

    /** True while the WebView is showing the cloud snapshot instead of the PC. */
    private var onFallback = false
    /** One proceed() per page load; a second challenge means the creds are wrong. */
    private var authTried = false

    private fun getFbUrl(): String =
        prefs.getString("fbUrl", null) ?: ""

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Voice input needs RECORD_AUDIO; harmless if the user declines.
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.RECORD_AUDIO), 1)
        }

        web = WebView(this)
        // The menu used to be reachable only by pressing Back at the top level,
        // which is invisible unless you already know it exists. The button is
        // the discoverable way in; both open the same dialog.
        val root = FrameLayout(this).apply {
            addView(
                web,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT,
                ),
            )
            addView(menuButton(), FrameLayout.LayoutParams(dp(40), dp(40)).apply {
                gravity = Gravity.BOTTOM or Gravity.END
                bottomMargin = dp(14)
                marginEnd = dp(14)
            })
        }
        setContentView(root)

        // Android 15 (targetSdk 35) forces edge-to-edge: without insets the
        // page's top bar hides behind the status bar. Padding the FrameLayout
        // rather than the WebView keeps the button inside the safe area too,
        // so it never sits under the navigation bar.
        window.decorView.setBackgroundColor(Color.parseColor("#05060a"))
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true // the app relies on localStorage
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            cacheMode = WebSettings.LOAD_DEFAULT
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)

        web.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                authTried = false
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?
            ) {
                if (request?.isForMainFrame != true) return
                if (!onFallback && getFbUrl().isNotBlank()) {
                    // PC unreachable — show the VPS cloud snapshot instead.
                    onFallback = true
                    Toast.makeText(
                        this@MainActivity,
                        "PC unreachable — showing cloud snapshot",
                        Toast.LENGTH_SHORT
                    ).show()
                    web.loadUrl(getFbUrl())
                } else {
                    // Fallback failed too (offline / bad URL) — back to the prompt.
                    promptForUrl(getUrl())
                }
            }

            override fun onReceivedHttpAuthRequest(
                view: WebView?,
                handler: HttpAuthHandler?,
                host: String?,
                realm: String?
            ) {
                val u = prefs.getString("fbUser", null)
                val p = prefs.getString("fbPass", null)
                if (u != null && p != null && !authTried) {
                    authTried = true // a second challenge = wrong creds -> dialog
                    handler?.proceed(u, p)
                } else {
                    promptForAuth(handler)
                }
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                val wantsMic = request.resources.any { it == PermissionRequest.RESOURCE_AUDIO_CAPTURE }
                val hasMic = ContextCompat.checkSelfPermission(
                    this@MainActivity, Manifest.permission.RECORD_AUDIO
                ) == PackageManager.PERMISSION_GRANTED
                if (wantsMic && hasMic) request.grant(request.resources) else request.deny()
            }
        }

        // Clear the web cache once per app update — bundles cached before the
        // server sent no-cache headers would otherwise pin a stale UI forever.
        val ver = PackageInfoCompat.getLongVersionCode(
            packageManager.getPackageInfo(packageName, 0)
        ).toInt()
        if (prefs.getInt("ver", 0) != ver) {
            web.clearCache(true)
            prefs.edit().putInt("ver", ver).apply()
        }

        val saved = getUrl()
        if (saved.isNullOrBlank()) promptForUrl(null) else web.loadUrl(routed(saved, intent))
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    /**
     * The floating menu button. Deliberately small and translucent: it sits
     * over the page, so it has to be reachable without being in the way.
     */
    private fun menuButton(): TextView = TextView(this).apply {
        text = "☰"
        gravity = Gravity.CENTER
        setTextColor(Color.parseColor("#e6e8f0"))
        textSize = 17f
        contentDescription = "cipher menu"
        alpha = 0.82f
        background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(Color.parseColor("#1a2030"))
            setStroke(dp(1), Color.parseColor("#3d4658"))
        }
        setOnClickListener { showMenu() }
    }

    private fun getUrl(): String? = prefs.getString("url", null)

    /** The saved URL, pointed at a widget-supplied route when there is one. */
    private fun routed(saved: String, intent: Intent?): String {
        val route = intent?.getStringExtra("route")
        return if (route.isNullOrBlank()) saved else deepLink(saved, route)
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        val route = intent?.getStringExtra("route") ?: return
        val saved = getUrl() ?: return
        onFallback = false
        web.loadUrl(deepLink(saved, route))
    }

    override fun onResume() {
        super.onResume()
        Widgets.requestRefresh(this)
        // Only while parked on the snapshot: one cheap probe, switch back if the PC answers.
        if (!onFallback) return
        val live = getUrl() ?: return
        Thread {
            val alive = try {
                val c = URL(live).openConnection() as HttpURLConnection
                c.connectTimeout = 2000
                c.readTimeout = 2000
                c.responseCode > 0
            } catch (e: Exception) {
                false
            }
            if (alive) runOnUiThread {
                onFallback = false
                // routed(), not a bare `live`: a probe that resolves just after
                // a widget deep link landed would otherwise drop the route.
                //
                // The route is never cleared, so every later snapshot-to-live
                // promotion in this Activity's lifetime replays it. Deliberate —
                // the promotion swaps the whole document and loses the reader's
                // place regardless, and the widget route is the last destination
                // the user actually asked for.
                web.loadUrl(routed(live, intent))
            }
        }.start()
    }

    private fun promptForAuth(handler: HttpAuthHandler?) {
        val user = EditText(this).apply {
            hint = "Username"
            setText(prefs.getString("fbUser", "cipher"))
        }
        val pass = EditText(this).apply {
            hint = "Password"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 16, 48, 0)
            addView(user)
            addView(pass)
        }
        AlertDialog.Builder(this)
            .setTitle("Snapshot login")
            .setMessage("Basic-auth credentials for the cloud snapshot.")
            .setView(box)
            .setPositiveButton("Sign in") { _, _ ->
                val u = user.text.toString().trim()
                val p = pass.text.toString()
                prefs.edit().putString("fbUser", u).putString("fbPass", p).apply()
                authTried = true
                handler?.proceed(u, p)
            }
            .setNegativeButton("Cancel") { _, _ -> handler?.cancel() }
            .setCancelable(false)
            .show()
    }

    private fun promptForFbUrl() {
        val input = EditText(this).apply {
            hint = "https://snapshot.example.com/"
            setText(getFbUrl())
        }
        AlertDialog.Builder(this)
            .setTitle("Snapshot URL")
            .setMessage("Optional: your own protected snapshot URL. Leave blank to disable cloud fallback.")
            .setView(input)
            .setPositiveButton("Save") { _, _ ->
                prefs.edit().putString("fbUrl", input.text.toString().trim()).apply()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun promptForUrl(current: String?) {
        val input = EditText(this).apply {
            hint = "http://192.168.x.x:4600/?token=…"
            setText(current ?: "")
        }
        AlertDialog.Builder(this)
            .setTitle("Server URL")
            .setMessage("Enter the cipherManager server address shown on your PC (include the token).")
            .setView(input)
            .setPositiveButton("Connect") { _, _ ->
                val url = input.text.toString().trim()
                if (url.isNotEmpty()) {
                    prefs.edit().putString("url", url).apply()
                    web.loadUrl(url)
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    /**
     * Pair this device with the G2 facade so the widgets can read. The code is
     * approved in desktop Settings; polling stops when the dialog is dismissed
     * or the code's 5-minute TTL expires.
     */
    private fun pairWidget() {
        val base = serverBase(getUrl() ?: "")
        if (base.isEmpty()) {
            promptForUrl(null)
            return
        }
        Thread {
            val started = Http.post("$base/api/g2/pair/start", """{"device":"Android widget"}""", null)
            val code = started?.let { runCatching { JSONObject(it).getString("code") }.getOrNull() }
            onLiveUi {
                if (code == null) {
                    Toast.makeText(this, "Pairing failed — is the PC reachable?", Toast.LENGTH_SHORT).show()
                    return@onLiveUi
                }
                var polling = true
                val dialog = AlertDialog.Builder(this)
                    .setTitle("Pair widget")
                    .setMessage("Approve this code in cipherManager Settings:\n\n$code")
                    .setNegativeButton("Cancel") { _, _ -> polling = false }
                    .setOnDismissListener { polling = false }
                    .show()
                val handler = Handler(Looper.getMainLooper())
                val deadline = System.currentTimeMillis() + 5 * 60_000
                lateinit var poll: () -> Unit
                poll = {
                    if (polling && System.currentTimeMillis() < deadline) {
                        Thread {
                            val body = Http.post("$base/api/g2/pair/status", """{"code":"$code"}""", null)
                            val o = body?.let { runCatching { JSONObject(it) }.getOrNull() }
                            val token = if (o?.optString("status") == "approved") o.optString("token") else null
                            // onLiveUi, not runOnUiThread: leaving the screen
                            // never fires setOnDismissListener, so polling stays
                            // true and this keeps landing for up to 5 minutes,
                            // ending in dismiss() on a destroyed Activity.
                            onLiveUi {
                                if (!polling) return@onLiveUi
                                if (!token.isNullOrEmpty()) {
                                    polling = false
                                    prefs.edit().putString("g2Token", token).apply()
                                    dialog.dismiss()
                                    Toast.makeText(this, "Widget paired", Toast.LENGTH_SHORT).show()
                                    Widgets.requestRefresh(this)
                                } else {
                                    handler.postDelayed({ poll() }, 2000)
                                }
                            }
                        }.start()
                    } else if (polling) {
                        polling = false
                        // Same reason: the 5-minute expiry can land after the
                        // Activity is gone.
                        onLiveUi {
                            dialog.dismiss()
                            Toast.makeText(this, "Pairing code expired", Toast.LENGTH_SHORT).show()
                        }
                    }
                }
                poll()
            }
        }.start()
    }

    /**
     * runOnUiThread, but a no-op once the Activity is gone. Every dialog below
     * is raised from a network callback that can outlive the screen, and
     * showing one on a finished Activity throws BadTokenException.
     */
    private fun onLiveUi(block: () -> Unit) = runOnUiThread {
        if (!isFinishing && !isDestroyed) block()
    }

    /** Choose which skill the Today widget's button runs. */
    private fun pickWidgetSkill() {
        val saved = getUrl() ?: ""
        val base = serverBase(saved)
        // Guard on the derived base, matching pairWidget: a saved value of "/"
        // or "?" is non-blank but yields an empty base, and would otherwise
        // reach the network and report "No skills found".
        if (base.isEmpty()) {
            promptForUrl(null)
            return
        }
        Thread {
            val body = Http.post("$base/api/get_skills", "{}", tokenOf(saved))
            // The whole walk, not just the outer parse: getJSONObject throws if
            // any element is not an object, and this lands on the UI thread.
            val skills = body?.let {
                runCatching {
                    val arr = org.json.JSONArray(it)
                    (0 until arr.length()).map { i ->
                        val o = arr.getJSONObject(i)
                        o.optString("id") to o.optString("name")
                    }
                }.getOrNull()
            }
            onLiveUi {
                if (skills.isNullOrEmpty()) {
                    Toast.makeText(this, "No skills found", Toast.LENGTH_SHORT).show()
                    return@onLiveUi
                }
                val ids = skills.map { it.first }
                val names = skills.map { it.second }
                AlertDialog.Builder(this)
                    .setTitle("Widget skill")
                    .setItems(names.toTypedArray()) { _, i ->
                        prefs.edit()
                            .putString("widgetSkillId", ids[i])
                            .putString("widgetSkillName", names[i])
                            .apply()
                        Widgets.requestRefresh(this)
                    }
                    .show()
            }
        }.start()
    }

    override fun onBackPressed() {
        if (web.canGoBack()) {
            web.goBack()
            return
        }
        // At the top level, back offers settings/exit instead of quitting abruptly.
        showMenu()
    }

    /** The app menu. Opened by the floating button, and by Back at the top level. */
    private fun showMenu() {
        AlertDialog.Builder(this)
            .setTitle("cipher")
            .setItems(
                arrayOf(
                    "Change server URL", "Reload", "Open cloud snapshot",
                    "Try live server", "Change snapshot URL", "Pair widget",
                    "Widget skill", "Exit"
                )
            ) { _, which ->
                when (which) {
                    0 -> promptForUrl(getUrl())
                    1 -> web.reload()
                    2 -> { onFallback = true; web.loadUrl(getFbUrl()) }
                    3 -> {
                        onFallback = false
                        val live = getUrl()
                        if (live.isNullOrBlank()) promptForUrl(null) else web.loadUrl(live)
                    }
                    4 -> promptForFbUrl()
                    5 -> pairWidget()
                    6 -> pickWidgetSkill()
                    7 -> finish()
                }
            }
            .show()
    }
}
