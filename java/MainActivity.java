package io.github.limpdangler.vidsearch;

import android.app.Activity;
import android.app.UiModeManager;
import android.content.Context;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Message;
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
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.util.Arrays;
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

        if (savedState == null || web.restoreState(savedState) == null) {
            web.loadUrl(HOME);
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
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
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
        web.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            root.removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
