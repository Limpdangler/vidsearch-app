package io.github.limpdangler.vidsearch;

import android.app.Activity;
import android.app.PendingIntent;
import android.app.PictureInPictureParams;
import android.app.RemoteAction;
import android.app.UiModeManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.drawable.Icon;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.util.Rational;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Vid Search app.
 *
 * Shows the live Vid Search website full screen, and enforces three rules the
 * website can't enforce by itself:
 *   1. No pop-ups / new windows   (the app never opens them)
 *   2. No redirects               (the page can't be sent to another website)
 *   3. No ad networks             (requests to known ad companies are dropped)
 * Players can't detect rules 1 and 2. Rule 3 uses the AD_HOSTS list below.
 */
public class MainActivity extends Activity {

    private static final String HOME      = "https://limpdangler.github.io/VidSearch/";
    private static final String SITE_HOST = "limpdangler.github.io";

    // Known ad / pop-up / tracking networks. A request to any of these, or any
    // address ending in one of them (e.g. "x.popads.net"), is dropped.
    // If a video source ever stops working in the app, a line here may be the cause.
    private static final Set<String> AD_HOSTS = new HashSet<>(Arrays.asList(
        // Google ads & tracking
        "doubleclick.net", "googlesyndication.com", "googleadservices.com",
        "adservice.google.com", "google-analytics.com", "googletagservices.com",
        "googletagmanager.com", "imasdk.googleapis.com",
        // Pop-up / pop-under / redirect networks (common on streaming players)
        "popads.net", "popcash.net", "propellerads.com", "propellerclick.com",
        "onclickads.net", "onclkds.com", "onclickperformance.com", "onclickmax.com",
        "adsterra.com", "adsterratech.com", "highperformanceformat.com",
        "effectiveratecpm.com", "profitablecpmrate.com", "profitablegatecpm.com",
        "highcpmrevenuegate.com", "exoclick.com", "exosrv.com", "exdynsrv.com",
        "juicyads.com", "hilltopads.net", "hilltopads.com", "clickadu.com",
        "clickaine.com", "adcash.com", "a-ads.com", "monetag.com", "galaksion.com",
        "admaven.com", "ad-maven.com", "adskeeper.com", "bidvertiser.com",
        "yllix.com", "popmyads.com", "pushame.com", "richpush.co", "dolohen.com",
        "acscdn.com", "trafficjunky.net", "trafficstars.com", "tsyndicate.com",
        "adxpremium.services", "aclib.net", "adnium.com", "zeroredirect1.com",
        "plugrush.com", "realsrv.com", "mmpcdn.com", "adbetnet.com",
        // Display ad exchanges & recommendation widgets
        "adnxs.com", "rubiconproject.com", "pubmatic.com", "criteo.com", "criteo.net",
        "amazon-adsystem.com", "taboola.com", "outbrain.com", "revcontent.com",
        "mgid.com", "zedo.com", "33across.com", "openx.net", "smartadserver.com",
        "adform.net", "casalemedia.com", "yieldmo.com", "sharethrough.com",
        // Crypto miners
        "coinhive.com", "coin-hive.com", "cryptoloot.pro", "webminepool.com"
    ));

    private FrameLayout root;
    private WebView web;
    private View fullView;                                  // what's shown while a video is fullscreen
    private WebChromeClient.CustomViewCallback fullCallback;
    private boolean isTv;
    private long lastToast;

    // Picture-in-picture: shrink the video into a floating window when you press Home
    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean playerOpen;        // is Vid Search's player showing? (checked every 2 s)
    private boolean pipJustEnded;      // PiP window closed, or expanded back to full app?
    private boolean pipPlaying;        // is the video playing? (for the play/pause icon)
    private boolean pipCanControl;     // can this source be paused? (VidNest / VidRift yes, vidsrc no)
    private boolean receiverOn;
    private static final String ACTION_TOGGLE = "io.github.limpdangler.vidsearch.PIP_TOGGLE";

    // Headphone buttons: the app registers as "the media player" so Android sends it
    // play/pause presses, which are passed on to the website's player.
    private MediaSession session;

    // The floating window's play/pause button sends this; we pass it on to the website
    private final BroadcastReceiver pipReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (web == null || !ACTION_TOGGLE.equals(intent.getAction())) return;
            web.evaluateJavascript(
                "(function(){try{return vsPipToggle();}catch(e){return 'none';}})()",
                r -> {
                    if ("\"playing\"".equals(r)) pipPlaying = true;
                    else if ("\"paused\"".equals(r)) pipPlaying = false;
                    updatePip();
                    updateSession();
                });
        }
    };

    // Shows only the player, filling the little window
    private static final String PIP_ON_JS =
        "(function(){var s=document.getElementById('vs-pip');if(!s){s=document.createElement('style');" +
        "s.id='vs-pip';document.head.appendChild(s);}s.textContent=" +
        "'body>*:not(#player){display:none!important}" +
        "body{margin:0!important;padding:0!important;overflow:hidden!important;background:#000!important}" +
        "#player{position:fixed!important;inset:0!important;max-width:none!important;margin:0!important;z-index:2147483647}" +
        "#player>*:not(.player-frame){display:none!important}" +
        "#player .player-frame{width:100vw!important;height:100vh!important;aspect-ratio:auto!important;border:0!important;border-radius:0!important}" +
        "#player .up-next,#player .skip-btn{display:none!important}" +
        // invisible shield over the video, so taps on the floating window don't pop up the player's controls
        "#player .player-frame::after{content:\"\";position:absolute;inset:0;z-index:9}';})()";
    private static final String PIP_OFF_JS =
        "(function(){var s=document.getElementById('vs-pip');if(s)s.remove();})()";

    private final Runnable checkPlayer = new Runnable() {
        @Override
        public void run() {
            if (web != null) {
                // '0' = nothing playing; otherwise 3 digits: open, playing, can-control
                web.evaluateJavascript(
                    "(function(){try{if(typeof vsPipState==='function')return vsPipState();" +
                    "return (typeof current!=='undefined'&&current)?'100':'0';}catch(e){return '0';}})()",
                    r -> {
                        String s = r == null ? "" : r.replace("\"", "");
                        boolean open = s.startsWith("1");
                        boolean playing = open && s.length() > 1 && s.charAt(1) == '1';
                        boolean control = open && s.length() > 2 && s.charAt(2) == '1';
                        boolean changed = playing != pipPlaying || control != pipCanControl;
                        playerOpen = open;
                        pipPlaying = playing;
                        pipCanControl = control;
                        if (changed) updatePip();
                        updateSession();
                    });
            }
            handler.postDelayed(this, 2000);
        }
    };

    @Override
    protected void onCreate(Bundle savedState) {
        super.onCreate(savedState);

        Window w = getWindow();
        w.setStatusBarColor(Color.BLACK);
        w.setNavigationBarColor(Color.BLACK);
        w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); // don't dim mid-episode

        UiModeManager ui = (UiModeManager) getSystemService(Context.UI_MODE_SERVICE);
        isTv = (ui != null && ui.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION)
                || getPackageManager().hasSystemFeature(PackageManager.FEATURE_LEANBACK);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                    // Continue watching, sync profile, settings
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);    // allow auto-play
        s.setSupportMultipleWindows(true);               // so pop-up attempts come to us (and get refused)
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setAllowFileAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        // Lets the website know it's running inside the app
        s.setUserAgentString(s.getUserAgentString() + " VidSearchApp/1");

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, true);   // some players need their own cookies

        web.setWebViewClient(new WebViewClient() {

            // Rule 2: the page itself may only show Vid Search
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                String scheme = u.getScheme();
                if (!"http".equals(scheme) && !"https".equals(scheme)) {
                    if (req.isForMainFrame() || req.hasGesture()) blocked("Blocked a link to another app");
                    return true;                          // e.g. ads trying to open the Play Store
                }
                if (!req.isForMainFrame()) return isAd(u.getHost()); // inside the player box
                if (SITE_HOST.equalsIgnoreCase(u.getHost())) return false;
                blocked("Blocked a redirect");
                return true;
            }

            // Rule 3: drop anything going to an ad network (runs for every request)
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                if (isAd(req.getUrl().getHost())) {
                    return new WebResourceResponse("text/plain", "utf-8",
                            new ByteArrayInputStream(new byte[0]));
                }
                return null;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {

            // Rule 1: refuse every attempt to open a new window / tab
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                blocked("Blocked a pop-up");
                return false;
            }

            // Video (or Vid Search's own fullscreen button) going fullscreen
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (fullView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                fullView = view;
                fullCallback = callback;
                root.addView(view, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                web.setVisibility(View.GONE);
                immersive(true);
                if (!isTv) setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
            }

            @Override
            public void onHideCustomView() {
                exitFullscreen();
            }

            // Hides the grey "play" placeholder Android shows before a video loads
            @Override
            public Bitmap getDefaultVideoPoster() {
                return Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
            }
        });

        addPlayerHelper();

        if (savedState == null || web.restoreState(savedState) == null) {
            web.loadUrl(HOME);
        }
        handler.postDelayed(checkPlayer, 2000);

        // Headphone / Bluetooth play-pause button
        session = new MediaSession(this, "VidSearch");
        if (Build.VERSION.SDK_INT < 26) {
            session.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
        }
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay()  { headphonePlayPause(true); }
            @Override public void onPause() { headphonePlayPause(false); }
            // Double-press ("next track") intentionally does nothing
        });

        // Listen for the floating window's play/pause button
        if (Build.VERSION.SDK_INT >= 26) {
            IntentFilter filter = new IntentFilter(ACTION_TOGGLE);
            if (Build.VERSION.SDK_INT >= 33) registerReceiver(pipReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
            else registerReceiver(pipReceiver, filter);
            receiverOn = true;
        }
    }

    // Pressing Home while a video is playing: shrink it into a floating window (phones only)
    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (isTv || Build.VERSION.SDK_INT < 26) return;
        if (!playerOpen && fullView == null) return;
        // Switch to "video only" straight away, so the page doesn't flash while the window shrinks
        if (fullView == null) web.evaluateJavascript(PIP_ON_JS, null);
        try {
            enterPictureInPictureMode(pipParams());
        } catch (Exception ignored) {
            // Picture-in-picture switched off for this app in Android settings
        }
    }

    // The floating window's settings: 16:9, and a single play/pause button
    // (only for sources that can be paused). No previous / next buttons.
    private PictureInPictureParams pipParams() {
        List<RemoteAction> actions = new ArrayList<>();
        if (pipCanControl) {
            Intent intent = new Intent(ACTION_TOGGLE).setPackage(getPackageName());
            PendingIntent pi = PendingIntent.getBroadcast(this, 1, intent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            String label = pipPlaying ? "Pause" : "Play";
            Icon icon = Icon.createWithResource(this,
                    pipPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play);
            actions.add(new RemoteAction(icon, label, label, pi));
        }
        return new PictureInPictureParams.Builder()
                .setAspectRatio(new Rational(16, 9))
                .setActions(actions)
                .build();
    }

    // A headphone press: play or pause the video
    private void headphonePlayPause(boolean wantPlay) {
        if (web == null) return;
        boolean inPip = Build.VERSION.SDK_INT >= 24 && isInPictureInPictureMode();
        web.evaluateJavascript(
            "(function(){try{return vsPlayPause(" + wantPlay + "," + inPip + ");}catch(e){return 'none';}})()",
            r -> {
                if ("\"playing\"".equals(r)) pipPlaying = true;
                else if ("\"paused\"".equals(r)) pipPlaying = false;
                updatePip();
                updateSession();
            });
    }

    // Tell Android whether we're playing, so headphone presses come to us
    // (only while a pausable video — VidNest / VidRift — is open)
    private void updateSession() {
        if (session == null) return;
        boolean active = playerOpen && pipCanControl;
        if (active) {
            session.setPlaybackState(new PlaybackState.Builder()
                    .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE)
                    .setState(pipPlaying ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                              PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1f)
                    .build());
        }
        if (session.isActive() != active) session.setActive(active);
    }

    // Refresh the play/pause icon while in the floating window
    private void updatePip() {
        if (Build.VERSION.SDK_INT < 26 || !isInPictureInPictureMode()) return;
        try { setPictureInPictureParams(pipParams()); } catch (Exception ignored) {}
    }

    @Override
    public void onPictureInPictureModeChanged(boolean inPip, Configuration newConfig) {
        super.onPictureInPictureModeChanged(inPip, newConfig);
        if (web == null) return;
        if (inPip) {
            pipJustEnded = false;
            if (fullView == null) web.evaluateJavascript(PIP_ON_JS, null);
        } else {
            pipJustEnded = true;
            web.evaluateJavascript(PIP_OFF_JS, null);
        }
    }

    // Player helper (assets/vs-hook.js): added to every page and every box inside it
    // before their own code runs, so Vid Search can play / pause / jump the video in
    // any source. Needs a reasonably recent Android System WebView; if it's not
    // supported, nothing is added and Vid Search simply doesn't offer the feature.
    private void addPlayerHelper() {
        try {
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return;
            String script = readAsset("vs-hook.js");
            if (script == null) return;
            byte[] random = new byte[16];
            new SecureRandom().nextBytes(random);
            StringBuilder token = new StringBuilder();
            for (byte b : random) token.append(String.format(Locale.ROOT, "%02x", b));
            script = script.replace("__TOKEN__", token.toString());
            WebViewCompat.addDocumentStartJavaScript(web, script, Collections.singleton("*"));
        } catch (Exception ignored) {
            // Not available on this device — the website falls back to its normal behaviour
        }
    }

    private String readAsset(String name) {
        try (InputStream in = getAssets().open(name)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }

    // Is this address (or the site it belongs to) on the ad list?
    private static boolean isAd(String host) {
        if (host == null) return false;
        host = host.toLowerCase(Locale.ROOT);
        while (true) {
            if (AD_HOSTS.contains(host)) return true;
            int dot = host.indexOf('.');
            if (dot < 0) return false;
            host = host.substring(dot + 1);
        }
    }

    // A small note at the bottom of the screen, at most once every few seconds
    private void blocked(String message) {
        long now = System.currentTimeMillis();
        if (now - lastToast < 4000) return;
        lastToast = now;
    }

    private void exitFullscreen() {
        if (fullView == null) return;
        root.removeView(fullView);
        fullView = null;
        web.setVisibility(View.VISIBLE);
        immersive(false);
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        WebChromeClient.CustomViewCallback cb = fullCallback;
        fullCallback = null;
        if (cb != null) cb.onCustomViewHidden();
    }

    @SuppressWarnings("deprecation")
    private void immersive(boolean on) {
        View d = getWindow().getDecorView();
        if (on) {
            d.setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        } else {
            d.setSystemUiVisibility(0);
        }
    }

    // Back button: leave fullscreen, then close the player, then exit the app
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (fullView != null) {
            exitFullscreen();
            return;
        }
        web.evaluateJavascript(
            "(function(){try{if(typeof current!=='undefined'&&current){closePlayer();return 'closed';}}catch(e){}return 'none';})()",
            result -> {
                if (!"\"closed\"".equals(result)) {
                    if (web.canGoBack()) web.goBack();
                    else finish();
                }
            });
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
        // Keep playing while in the floating window
        if (Build.VERSION.SDK_INT >= 24 && isInPictureInPictureMode()) return;
        web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        pipJustEnded = false;
        web.onResume();
    }

    @Override
    protected void onStop() {
        super.onStop();
        // The floating window was closed (swiped away / ✕): stop the video.
        // Your spot is already saved, so it's in Continue watching.
        boolean closedFromPip = pipJustEnded
                || (Build.VERSION.SDK_INT >= 24 && isInPictureInPictureMode());
        if (closedFromPip && web != null) {
            pipJustEnded = false;
            if (fullView != null) exitFullscreen();
            web.evaluateJavascript(
                "(function(){try{if(typeof current!=='undefined'&&current)closePlayer();}catch(e){}})()", null);
            web.onPause();
        }
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacks(checkPlayer);
        if (session != null) {
            session.setActive(false);
            session.release();
            session = null;
        }
        if (receiverOn) {
            try { unregisterReceiver(pipReceiver); } catch (Exception ignored) {}
            receiverOn = false;
        }
        if (web != null) {
            root.removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
