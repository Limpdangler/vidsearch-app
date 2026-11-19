package io.github.limpdangler.vidsearch;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.PictureInPictureParams;
import android.app.RemoteAction;
import android.app.UiModeManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.drawable.Icon;
import android.media.MediaMetadata;
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

import org.json.JSONArray;
import org.json.JSONObject;

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

    // "Now playing" card in the notification shade (phones only): title, episode,
    // play/pause and a progress bar you can drag, like in the browser
    private static final String ACTION_MEDIA = "io.github.limpdangler.vidsearch.MEDIA_TOGGLE";
    private static final String CHANNEL = "now_playing";
    private static final int NOTE_ID = 7;
    private String npTitle = "", npEp = "";
    private long npPosMs = -1, npDurMs = 0;
    private boolean npHasNext;
    // The card's extra buttons (besides play/pause)
    private static final String CMD_BACK = "back10", CMD_FWD = "fwd10", CMD_NEXT = "nextEp", CMD_TOGGLE = "toggle", CMD_GAP = "gap";
    private String metaShown = "", noteShown = "";
    private boolean channelMade, askedNotify;

    // The floating window's play/pause button sends this; we pass it on to the website
    private final BroadcastReceiver pipReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (web == null) return;
            if (ACTION_MEDIA.equals(intent.getAction())) {   // a button on the notification card
                mediaCommand(intent.getStringExtra("cmd"));
                return;
            }
            if (!ACTION_TOGGLE.equals(intent.getAction())) return;
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
                // Second line: title, episode, position and length (for the notification card)
                web.evaluateJavascript(
                    "(function(){try{var s=(typeof vsPipState==='function')?vsPipState():" +
                    "((typeof current!=='undefined'&&current)?'100':'0');var n='';" +
                    "try{if(typeof vsNowPlaying==='function')n=vsNowPlaying();}catch(e){}" +
                    "return s+'\\n'+n;}catch(e){return '0';}})()",
                    r -> {
                        String all = jsString(r);
                        int nl = all.indexOf('\n');
                        String s = nl < 0 ? all : all.substring(0, nl);
                        readNowPlaying(nl < 0 ? "" : all.substring(nl + 1));
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
        // Lets the website know it's running inside the app (and on a TV, for the TV layout)
        s.setUserAgentString(s.getUserAgentString() + " VidSearchApp/1" + (isTv ? " VidSearchTV/1" : ""));

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
                // So the TV remote's buttons keep reaching Vid Search while fullscreen
                view.setFocusable(true);
                view.requestFocus();
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
            @Override public void onSeekTo(long ms) { seekTo(ms); }
            @Override public void onCustomAction(String action, Bundle extras) { mediaCommand(action); }
            // Double-press ("next track") intentionally does nothing
        });

        // Listen for the floating window's play/pause button
        if (Build.VERSION.SDK_INT >= 26) {
            IntentFilter filter = new IntentFilter(ACTION_TOGGLE);
            filter.addAction(ACTION_MEDIA);
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

    // Tell Android what's playing: headphone presses then come to us, and the
    // notification shade shows the "now playing" card
    private void updateSession() {
        if (session == null) return;
        boolean active = playerOpen;
        if (active) {
            String meta = npTitle + "\n" + npEp + "\n" + npDurMs;
            if (!meta.equals(metaShown)) {
                metaShown = meta;
                MediaMetadata.Builder m = new MediaMetadata.Builder()
                        .putString(MediaMetadata.METADATA_KEY_TITLE, npTitle.isEmpty() ? "Vid Search" : npTitle)
                        .putString(MediaMetadata.METADATA_KEY_ARTIST, npEp);
                if (npDurMs > 0) m.putLong(MediaMetadata.METADATA_KEY_DURATION, npDurMs);
                session.setMetadata(m.build());
            }
            long actions = 0;
            PlaybackState.Builder ps = new PlaybackState.Builder();
            if (pipCanControl) {
                actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE;
                if (npDurMs > 0) actions |= PlaybackState.ACTION_SEEK_TO;
                // Android puts the first two extra buttons where "previous" and "next" would go,
                // i.e. either side of play/pause
                ps.addCustomAction(new PlaybackState.CustomAction.Builder(
                        CMD_BACK, "Back 10 seconds", android.R.drawable.ic_media_rew).build());
                ps.addCustomAction(new PlaybackState.CustomAction.Builder(
                        CMD_FWD, "Forward 10 seconds", android.R.drawable.ic_media_ff).build());
            }
            if (npHasNext) {
                // An empty gap first, so Next episode sits apart on the far right
                // (and isn't pressed by mistake instead of Forward 10 seconds)
                if (pipCanControl) {
                    ps.addCustomAction(new PlaybackState.CustomAction.Builder(
                            CMD_GAP, " ", R.drawable.blank).build());
                }
                ps.addCustomAction(new PlaybackState.CustomAction.Builder(
                        CMD_NEXT, "Next episode", android.R.drawable.ic_media_next).build());
            }
            session.setPlaybackState(ps
                    .setActions(actions)
                    .setState(pipPlaying ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                              npPosMs >= 0 ? npPosMs : PlaybackState.PLAYBACK_POSITION_UNKNOWN,
                              pipPlaying ? 1f : 0f)
                    .build());
        }
        if (session.isActive() != active) session.setActive(active);
        updateNotification();
    }

    // The "now playing" card in the notification shade (phones; not Fire TV)
    private void updateNotification() {
        if (isTv || Build.VERSION.SDK_INT < 26 || session == null) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        if (!playerOpen) {
            if (!noteShown.isEmpty()) { nm.cancel(NOTE_ID); noteShown = ""; }
            return;
        }
        String key = npTitle + "\n" + npEp + "\n" + pipPlaying + pipCanControl + npHasNext;
        if (key.equals(noteShown)) return;          // nothing changed

        // Android 13+ asks once whether Vid Search may show notifications
        if (Build.VERSION.SDK_INT >= 33 && !askedNotify
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            askedNotify = true;
            if (!getPreferences(MODE_PRIVATE).getBoolean("askedNotify", false)) {
                getPreferences(MODE_PRIVATE).edit().putBoolean("askedNotify", true).apply();
                try { requestPermissions(new String[]{ Manifest.permission.POST_NOTIFICATIONS }, 1); } catch (Exception ignored) {}
            }
        }
        if (!channelMade) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Now playing", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
            channelMade = true;
        }

        // Tapping the card opens the app
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openPi = PendingIntent.getActivity(this, 2, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.MediaStyle style = new Notification.MediaStyle().setMediaSession(session.getSessionToken());
        Notification.Builder b = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentTitle(npTitle.isEmpty() ? "Vid Search" : npTitle)
                .setContentText(npEp)
                .setContentIntent(openPi)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setOngoing(pipPlaying);
        // (Android 13+ draws its own buttons from the media session above; older versions use these)
        if (pipCanControl) {
            b.addAction(cardButton(3, CMD_BACK, "Back 10 seconds", android.R.drawable.ic_media_rew));
            b.addAction(cardButton(4, CMD_TOGGLE, pipPlaying ? "Pause" : "Play",
                    pipPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play));
            b.addAction(cardButton(5, CMD_FWD, "Forward 10 seconds", android.R.drawable.ic_media_ff));
            style.setShowActionsInCompactView(0, 1, 2);
        }
        if (npHasNext) b.addAction(cardButton(6, CMD_NEXT, "Next episode", android.R.drawable.ic_media_next));
        b.setStyle(style);
        try {
            nm.notify(NOTE_ID, b.build());
            noteShown = key;
        } catch (Exception ignored) {
            // Notifications switched off for the app
        }
    }

    private Notification.Action cardButton(int code, String cmd, String label, int icon) {
        PendingIntent pi = PendingIntent.getBroadcast(this, code,
                new Intent(ACTION_MEDIA).setPackage(getPackageName()).putExtra("cmd", cmd),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Action.Builder(Icon.createWithResource(this, icon), label, pi).build();
    }

    // A button on the notification card
    private void mediaCommand(String cmd) {
        if (web == null || cmd == null) return;
        switch (cmd) {
            case CMD_TOGGLE: headphonePlayPause(!pipPlaying); break;
            case CMD_BACK:   jump(-10); break;
            case CMD_FWD:    jump(10); break;
            case CMD_NEXT:
                web.evaluateJavascript("(function(){try{return vsNextEp();}catch(e){return 'none';}})()", null);
                break;
            default: break;
        }
    }

    // Back / forward a few seconds
    private void jump(int secs) {
        web.evaluateJavascript("(function(){try{return vsSkipBy(" + secs + ");}catch(e){return 'none';}})()", null);
        if (npPosMs >= 0) {
            npPosMs = Math.max(0, npPosMs + secs * 1000L);
            if (npDurMs > 0) npPosMs = Math.min(npPosMs, npDurMs);
        }
        updateSession();
    }

    // Title, episode, position and length from the website (blank if nothing / older site)
    private void readNowPlaying(String json) {
        try {
            if (json == null || json.isEmpty()) {
                npTitle = ""; npEp = ""; npPosMs = -1; npDurMs = 0; npHasNext = false;
                return;
            }
            JSONObject o = new JSONObject(json);
            npTitle = o.optString("t", "");
            npEp = o.optString("e", "");
            npPosMs = (long) (o.optDouble("pos", -1) * 1000);
            npDurMs = (long) (o.optDouble("dur", 0) * 1000);
            npHasNext = o.optBoolean("next", false);
        } catch (Exception ignored) {}
    }

    // Dragging the progress bar on the notification card
    private void seekTo(long ms) {
        if (web == null) return;
        long secs = Math.max(0, ms / 1000);
        web.evaluateJavascript("(function(){try{return vsSeekTo(" + secs + ");}catch(e){return 'none';}})()", null);
        npPosMs = secs * 1000;
        updateSession();
    }

    // Turns the website's answer ("\"text\"" in quotes) back into plain text
    private static String jsString(String r) {
        if (r == null || r.equals("null")) return "";
        try { return new JSONArray("[" + r + "]").optString(0, ""); } catch (Exception e) { return ""; }
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

    // Back button: leave fullscreen, then close the profile screen, then the player, then exit the app
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (fullView != null) {
            exitFullscreen();
            return;
        }
        web.evaluateJavascript(
            "(function(){try{if(typeof vsBack==='function'&&vsBack())return 'closed';" +
            "if(typeof current!=='undefined'&&current){closePlayer();return 'closed';}}catch(e){}return 'none';})()",
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
        if (Build.VERSION.SDK_INT >= 26 && !noteShown.isEmpty()) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.cancel(NOTE_ID);
        }
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
