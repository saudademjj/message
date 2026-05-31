package io.e2eechat.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public final class MainActivity extends Activity {
    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        configureWindow();

        webView = new WebView(this);
        configureWebView(webView);
        setContentView(webView);

        if (savedInstanceState == null) {
            webView.loadUrl(getString(R.string.chat_url));
        } else {
            webView.restoreState(savedInstanceState);
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView(WebView view) {
        view.setBackgroundColor(Color.rgb(11, 20, 26));
        view.setWebViewClient(new WebViewClient());
        view.setWebChromeClient(new WebChromeClient());

        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(view, true);
    }

    private void configureWindow() {
        Window window = getWindow();
        window.setStatusBarColor(Color.rgb(11, 20, 26));
        window.setNavigationBarColor(Color.rgb(11, 20, 26));
        window.getDecorView().setSystemUiVisibility(0);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
