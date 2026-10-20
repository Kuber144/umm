import Cocoa
import WebKit
import Carbon

final class Panel: NSPanel { override var canBecomeKey: Bool { true } }

var onHotKey: (() -> Void)?

final class App: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    let scheme = Scheme()
    let hotbar = Panel(contentRect: NSRect(x: 0, y: 0, width: 680, height: 400), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    var hotbarView: WKWebView!, main: NSWindow?, mainView: WKWebView?, pendingOpen: String?
    var status: NSStatusItem!, icon: NSImage!, red: NSImage!, lastApp = "", signals: [DispatchSourceSignal] = []

    func applicationDidFinishLaunching(_ n: Notification) {
        backend.start()
        NSApp.mainMenu = menuBar()
        status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        icon = Bundle.main.url(forResource: "StatusIcon", withExtension: "png").flatMap { NSImage(contentsOf: $0) }
            ?? NSImage(systemSymbolName: "brain", accessibilityDescription: "umm")!
        icon.size = NSSize(width: 18, height: 18)
        icon.isTemplate = true
        red = NSImage(size: icon.size, flipped: false) { r in
            self.icon.draw(in: r)
            NSColor.systemRed.set()
            r.fill(using: .sourceAtop)
            return true
        }
        status.button?.image = icon
        let m = NSMenu()
        m.addItem(withTitle: "Open umm", action: #selector(openMain), keyEquivalent: "").target = self
        m.addItem(withTitle: "Quit umm", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        status.menu = m

        hotbarView = makeView("#hotbar", transparent: true)
        hotbar.contentView = hotbarView
        // nonactivating keeps the panel on screen even when macOS refuses to activate us
        hotbar.isOpaque = false
        hotbar.backgroundColor = .clear
        hotbar.hasShadow = true
        hotbar.level = .floating
        hotbar.isReleasedWhenClosed = false
        hotbar.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        hotbar.delegate = self

        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        onHotKey = { [weak self] in self?.toggle() }
        InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in onHotKey?(); return noErr }, 1, &spec, nil, nil)
        var ref: EventHotKeyRef?
        RegisterEventHotKey(UInt32(kVK_Space), UInt32(controlKey | shiftKey), EventHotKeyID(signature: 0x756d6d20, id: 1), GetApplicationEventTarget(), 0, &ref)

        signal(SIGPIPE, SIG_IGN)
        for s in [SIGTERM, SIGINT] {
            signal(s, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: s, queue: .main)
            src.setEventHandler { backend.stop(); exit(0) }
            src.resume()
            signals.append(src)
        }

        switch ProcessInfo.processInfo.environment["UMM_SHOW"] {
        case "main": showMain(nil)
        case "hotbar": DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.toggle() }
        default: break
        }
        #if TEST // test hooks: SIGUSR1 toggles the hotbar, UMM_JS runs in the hotbar page
        let src = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
        signal(SIGUSR1, SIG_IGN)
        src.setEventHandler { self.toggle() }
        src.resume()
        signals.append(src)
        if let js = ProcessInfo.processInfo.environment["UMM_JS"] {
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { self.hotbarView.callAsyncJavaScript(js, in: nil, in: .page) { NSLog("UMM_JS \($0)") } }
        }
        #endif
    }

    func applicationWillTerminate(_ n: Notification) { backend.stop() }

    func menuBar() -> NSMenu {
        let bar = NSMenu()
        let menus: [(String, [(String, Selector, String)])] = [
            ("umm", [("Quit umm", #selector(NSApplication.terminate(_:)), "q")]),
            ("Edit", [("Undo", Selector(("undo:")), "z"), ("Redo", Selector(("redo:")), "Z"), ("Cut", #selector(NSText.cut(_:)), "x"),
                      ("Copy", #selector(NSText.copy(_:)), "c"), ("Paste", #selector(NSText.paste(_:)), "v"), ("Select All", #selector(NSText.selectAll(_:)), "a")]),
            ("Window", [("Close", #selector(NSWindow.performClose(_:)), "w")])]
        for (title, items) in menus {
            let sub = NSMenu(title: title)
            for (t, s, k) in items { sub.addItem(withTitle: t, action: s, keyEquivalent: k) }
            let item = NSMenuItem()
            item.submenu = sub
            bar.addItem(item)
        }
        return bar
    }

    // handler is this long-lived object, so the controller retaining it makes no cycle
    func makeView(_ hash: String, transparent: Bool) -> WKWebView {
        let c = WKWebViewConfiguration()
        c.setURLSchemeHandler(scheme, forURLScheme: "umm")
        c.userContentController.add(self, name: "umm")
        let v = WKWebView(frame: .zero, configuration: c)
        v.navigationDelegate = self
        v.uiDelegate = self
        if transparent { v.setValue(false, forKey: "drawsBackground") }
        v.load(URLRequest(url: URL(string: "umm://app/" + hash)!))
        return v
    }

    // MARK: hotbar

    func toggle() {
        if hotbar.isVisible { return hideHotbar() }
        // fetch before activating so the frontmost app is still the user's
        DispatchQueue.global().async {
            let r = backend.request("GET", "/api/context", wait: 2)
            DispatchQueue.main.async { self.showHotbar(r?.0 == 200 ? String(decoding: r!.2, as: UTF8.self) : "{}") }
        }
    }

    func showHotbar(_ ctx: String) {
        lastApp = ((try? JSONSerialization.jsonObject(with: Data(ctx.utf8))) as? [String: Any])?["app"] as? String ?? ""
        let s = NSScreen.screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) } ?? NSScreen.main!
        let f = s.visibleFrame, h = hotbar.frame.height
        hotbar.setFrame(NSRect(x: f.midX - 340, y: f.maxY - f.height * 0.2 - h, width: 680, height: h), display: false)
        NSApp.activate(ignoringOtherApps: true)
        hotbar.makeKeyAndOrderFront(nil)
        hotbar.makeFirstResponder(hotbarView)
        hotbarView.evaluateJavaScript("window.ummShow?.(\(ctx))")
    }

    func hideHotbar(restore: Bool = true) {
        guard hotbar.isVisible else { return }
        hotbar.orderOut(nil)
        if restore && main == nil && NSApp.isActive { NSApp.hide(nil) }
    }

    func windowDidResignKey(_ n: Notification) { if n.object as? NSWindow === hotbar { hideHotbar() } }

    // MARK: main window

    @objc func openMain() { showMain(nil) }

    func showMain(_ query: String?) {
        let open = "window.ummOpen?.(" + String(decoding: (try? JSONSerialization.data(withJSONObject: query.map { ["query": $0] } ?? [:])) ?? Data("{}".utf8), as: UTF8.self) + ")"
        if main == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 720),
                             styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
            w.titlebarAppearsTransparent = true
            w.titleVisibility = .hidden
            w.minSize = NSSize(width: 760, height: 480)
            w.isReleasedWhenClosed = false
            w.delegate = self
            w.center()
            mainView = makeView("", transparent: false)
            w.contentView = mainView
            main = w
            pendingOpen = open
        } else {
            mainView?.evaluateJavaScript(open)
        }
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        main?.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ n: Notification) {
        guard n.object as? NSWindow === main else { return }
        mainView?.stopLoading()
        main?.contentView = nil
        main?.delegate = nil
        mainView = nil
        main = nil
        NSApp.setActivationPolicy(.accessory)
    }

    func webView(_ w: WKWebView, didFinish n: WKNavigation!) {
        if w === mainView, let js = pendingOpen { pendingOpen = nil; w.evaluateJavaScript(js) }
    }

    // MARK: bridge

    func userContentController(_ u: WKUserContentController, didReceive m: WKScriptMessage) {
        guard let d = m.body as? [String: Any], let t = d["type"] as? String else { return }
        switch t {
        case "hide": hideHotbar()
        case "saved": hideHotbar(); play("Pop")
        case "error": play("Basso")
        case "capture":
            hideHotbar()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.capture() }
        case "openMain": hideHotbar(restore: false); showMain(d["query"] as? String)
        case "recording": status.button?.image = (d["on"] as? Bool) == true ? red : icon
        case "resize":
            if let h = d["height"] as? Double {
                let f = hotbar.frame
                hotbar.setFrame(NSRect(x: f.minX, y: f.maxY - h, width: 680, height: h), display: true)
                hotbar.invalidateShadow()
            }
        case "openExternal": if let s = d["url"] as? String, let u = URL(string: s) { NSWorkspace.shared.open(u) }
        case "quit": NSApp.terminate(nil)
        default: break
        }
    }

    func play(_ name: String) { NSSound(named: name)?.play() }

    func capture() {
        let body = (try? JSONSerialization.data(withJSONObject: ["app": lastApp])) ?? Data()
        DispatchQueue.global().async {
            let r = backend.request("POST", "/api/capture", headers: ["Content-Type": "application/json"], body: body)
            DispatchQueue.main.async { self.play(r?.0 == 200 ? "Pop" : "Basso") }
        }
    }

    // MARK: web view delegates

    func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let u = a.request.url, u.scheme != "umm" && u.scheme != "about" { NSWorkspace.shared.open(u); decisionHandler(.cancel) } else { decisionHandler(.allow) }
    }

    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures f: WKWindowFeatures) -> WKWebView? {
        if let u = a.request.url, u.scheme != "umm" { NSWorkspace.shared.open(u) }
        return nil
    }

    func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert()
        a.messageText = m
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "Cancel")
        completionHandler(a.runModal() == .alertFirstButtonReturn)
    }

    func webViewWebContentProcessDidTerminate(_ w: WKWebView) { w.reload() }
}

let delegate = App()
NSApplication.shared.delegate = delegate
NSApp.setActivationPolicy(.accessory)
NSApp.run()
