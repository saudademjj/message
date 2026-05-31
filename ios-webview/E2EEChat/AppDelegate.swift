import UIKit
import WebKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate, WKNavigationDelegate {
    internal var window: UIWindow?
    private var webView: WKWebView?
    private let chatURL = URL(string: "https://chat.example.com")!

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.customUserAgent = "SecureLinkOnline iOS"
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.load(URLRequest(url: chatURL))

        let viewController = UIViewController()
        viewController.view.backgroundColor = UIColor(red: 11 / 255, green: 20 / 255, blue: 26 / 255, alpha: 1)
        viewController.view.addSubview(webView)
        webView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: viewController.view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: viewController.view.trailingAnchor),
            webView.topAnchor.constraint(equalTo: viewController.view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: viewController.view.bottomAnchor),
        ])

        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = viewController
        window.makeKeyAndVisible()

        self.webView = webView
        self.window = window
        return true
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let host = navigationAction.request.url?.host else {
            decisionHandler(.allow)
            return
        }

        if host == chatURL.host {
            decisionHandler(.allow)
            return
        }

        decisionHandler(.cancel)
    }
}
