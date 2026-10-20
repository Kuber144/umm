import WebKit

// umm:// scheme: forwards every request to the backend over the Unix socket
final class Scheme: NSObject, WKURLSchemeHandler {
    var live = Set<ObjectIdentifier>()

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        let id = ObjectIdentifier(task as AnyObject)
        live.insert(id)
        let r = task.request
        let c = URLComponents(url: r.url!, resolvingAgainstBaseURL: false)!
        let target = (c.percentEncodedPath.isEmpty ? "/" : c.percentEncodedPath) + (c.percentEncodedQuery.map { "?" + $0 } ?? "")
        var body = r.httpBody ?? Data()
        if body.isEmpty, let s = r.httpBodyStream {
            s.open()
            var buf = [UInt8](repeating: 0, count: 65536)
            while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; body.append(contentsOf: buf[..<n]) }
            s.close()
        }
        var h: [String: String] = [:]
        for k in ["Content-Type", "Range"] { if let v = r.value(forHTTPHeaderField: k) { h[k] = v } }
        let method = r.httpMethod ?? "GET"
        DispatchQueue.global().async {
            let res = backend.request(method, target, headers: h, body: body)
            DispatchQueue.main.async {
                guard self.live.remove(id) != nil else { return }
                guard let (status, headers, data) = res else { return task.didFailWithError(URLError(.cannotConnectToHost)) }
                let skip: Set = ["content-length", "transfer-encoding", "connection"]
                task.didReceive(HTTPURLResponse(url: r.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers.filter { !skip.contains($0.key) })!)
                task.didReceive(data)
                task.didFinish()
            }
        }
    }

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) { live.remove(ObjectIdentifier(task as AnyObject)) }
}
