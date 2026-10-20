import ServiceManagement

extension App {
    // Settings page bridge. `on` registers or unregisters the login item, nil only reports.
    // Replies with window.ummSettings({loginItem: on | approval | off | missing, version}).
    func loginItem(_ on: Bool?) {
        if let on {
            do { if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() } }
            catch { NSLog("umm: login item: \(error)") }
        }
        let state: String
        switch SMAppService.mainApp.status {
        case .enabled: state = "on"
        case .requiresApproval: state = "approval"
        case .notFound: state = "missing"
        default: state = "off"
        }
        NSLog("umm: login item \(state)")
        let info: [String: Any] = ["loginItem": state, "version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") ?? ""]
        let json = (try? JSONSerialization.data(withJSONObject: info)).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
        mainView?.evaluateJavaScript("window.ummSettings?.(\(json))")
    }
}
