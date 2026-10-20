import Cocoa
import WebKit
import Carbon

final class Panel: NSPanel { override var canBecomeKey: Bool { true } }

var onHotKey: (() -> Void)?

// main window: dropped files go to the page as paths instead of WebKit opening them. Text drops stay with WebKit
final class DropView: WKWebView {
    func paths(_ d: NSDraggingInfo) -> [String] {
        (d.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []).map(\.path)
    }
    override func draggingEntered(_ d: NSDraggingInfo) -> NSDragOperation { let o = super.draggingEntered(d); return paths(d).isEmpty ? o : .copy }
    override func draggingUpdated(_ d: NSDraggingInfo) -> NSDragOperation { let o = super.draggingUpdated(d); return paths(d).isEmpty ? o : .copy }
    override func performDragOperation(_ d: NSDraggingInfo) -> Bool {
        let p = paths(d)
        if p.isEmpty { return super.performDragOperation(d) }
        super.draggingExited(d) // the page ends its drag state, WebKit never sees the drop
        evaluateJavaScript("window.ummDrop?.(" + String(decoding: (try? JSONSerialization.data(withJSONObject: ["paths": p])) ?? Data("{}".utf8), as: UTF8.self) + ")")
        return true
    }
    // the empty top of the sidebar (200 by 52 points) moves the window. WebKit has no drag region for the page
    func strip(_ p: NSPoint) -> Bool { p.x < 200 && (isFlipped ? p.y : bounds.height - p.y) < 52 }
    override func hitTest(_ p: NSPoint) -> NSView? { strip(convert(p, from: superview)) ? self : super.hitTest(p) }
    override func mouseDown(with e: NSEvent) { strip(convert(e.locationInWindow, from: nil)) ? window?.performDrag(with: e) : super.mouseDown(with: e) }
}

final class App: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    let scheme = Scheme()
    let hotbar = Panel(contentRect: NSRect(x: 0, y: 0, width: 680, height: 400), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    var hotbarView: WKWebView!, main: NSWindow?, mainView: WKWebView?, pendingOpen: String?
    var status: NSStatusItem!, icon: NSImage!, red: NSImage!, lastApp = "", lastURL: String?, lastDisplay: Int?, signals: [DispatchSourceSignal] = []

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

        if !CGPreflightScreenCaptureAccess() { CGRequestScreenCaptureAccess() }

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
        let v: WKWebView = hash.isEmpty ? DropView(frame: .zero, configuration: c) : WKWebView(frame: .zero, configuration: c)
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
            // a data: URL can be megabytes, and over 64 KB the backend refuses the request
            let path = "/api/context" + (self.pageURL().flatMap { $0.count < 4000 ? $0.addingPercentEncoding(withAllowedCharacters: .alphanumerics) : nil }.map { "?url=" + $0 } ?? "")
            let first = backend.request("GET", path, wait: 2)
            let r = first?.0 == 200 ? first : backend.request("GET", path, wait: 2) // the page breaks on "{}", so try twice
            DispatchQueue.main.async { self.showHotbar(r?.0 == 200 ? String(decoding: r!.2, as: UTF8.self) : "{}") }
        }
    }

    // the front window's document or web page, read over Accessibility. nil without the permission
    func pageURL() -> String? {
        guard AXIsProcessTrusted(), let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier else { return nil }
        func get(_ e: CFTypeRef, _ k: String) -> CFTypeRef? { var v: CFTypeRef?; return AXUIElementCopyAttributeValue(e as! AXUIElement, k as CFString, &v) == .success ? v : nil }
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.5) // a hung app must not hold up the hotbar
        let app = AXUIElementCreateApplication(pid)
        if let w = get(app, kAXFocusedWindowAttribute), let d = get(w, kAXDocumentAttribute) as? String, !d.isEmpty { return d }
        var e = get(app, kAXFocusedUIElementAttribute), n = 0 // browsers: walk up from the focus to its web area
        while let x = e, n < 50 {
            if get(x, kAXRoleAttribute) as? String == "AXWebArea" { return (get(x, "AXURL") as? URL)?.absoluteString }
            e = get(x, kAXParentAttribute)
            n += 1
        }
        return nil
    }

    func showHotbar(_ ctx: String) {
        let c = (try? JSONSerialization.jsonObject(with: Data(ctx.utf8))) as? [String: Any]
        lastApp = c?["app"] as? String ?? ""
        lastURL = c?["url"] as? String
        let s = NSScreen.screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) } ?? NSScreen.main!
        // screencapture -D takes the 1-based position in the active display list
        var ids = [CGDirectDisplayID](repeating: 0, count: 16), n: UInt32 = 0
        CGGetActiveDisplayList(16, &ids, &n)
        lastDisplay = (s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID)
            .flatMap { ids.prefix(Int(n)).firstIndex(of: $0) }.map { $0 + 1 }
        let f = s.visibleFrame, h = hotbar.frame.height
        hotbar.setFrame(NSRect(x: f.midX - 340, y: f.maxY - f.height * 0.2 - h, width: 680, height: h), display: false)
        if main == nil { NSApp.activate(ignoringOtherApps: true) } // activating would raise the main window over the user's app
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
        case "capture", "area":
            hideHotbar()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.capture(area: t == "area") }
        case "openMain": hideHotbar(restore: false); showMain(d["query"] as? String)
        case "recording": status.button?.image = (d["on"] as? Bool) == true ? red : icon
        case "resize":
            if let h = d["height"] as? Double {
                let f = hotbar.frame
                hotbar.setFrame(NSRect(x: f.minX, y: f.maxY - h, width: 680, height: h), display: true)
                hotbar.invalidateShadow()
            }
        case "openExternal": if let s = d["url"] as? String, let u = URL(string: s) { NSWorkspace.shared.open(u) }
        case "loginItem": loginItem(d["on"] as? Bool)
        case "settings": loginItem(nil)
        case "accessibility":
            AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary)
            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
            loginItem(nil)
        case "chooseFolder":
            let p = NSOpenPanel()
            p.canChooseFiles = false
            p.canChooseDirectories = true
            p.canCreateDirectories = true
            if p.runModal() == .OK, let path = p.url?.path, let js = try? JSONSerialization.data(withJSONObject: path, options: .fragmentsAllowed) {
                m.webView?.evaluateJavaScript("window.ummFolder?.(\(String(decoding: js, as: UTF8.self)))")
            }
        case "quit": NSApp.terminate(nil)
        default: break
        }
    }

    func play(_ name: String) { NSSound(named: name)?.play() }

    func capture(area: Bool) {
        var b: [String: Any] = ["app": lastApp, "area": area]
        if let d = lastDisplay { b["display"] = d }
        if let u = lastURL { b["meta"] = ["source": "hotbar", "url": u] }
        let body = (try? JSONSerialization.data(withJSONObject: b)) ?? Data()
        DispatchQueue.global().async {
            let r = backend.request("POST", "/api/capture", headers: ["Content-Type": "application/json"], body: body)
            // 200 with a null id means the selection was cancelled with Esc: no sound
            let saved = r.flatMap { (try? JSONSerialization.jsonObject(with: $0.2)) as? [String: Any] }?["id"] is Int
            DispatchQueue.main.async {
                if r?.0 != 200 { self.play("Basso") } else if saved { self.play("Pop") }
                if let why = [403: " Excluded app", 412: " Allow Screen Recording"][r?.0 ?? 0] { // say why in the menu bar for a moment
                    self.status.button?.title = why
                    DispatchQueue.main.asyncAfter(deadline: .now() + 3) { self.status.button?.title = "" }
                }
            }
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
