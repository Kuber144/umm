import Foundation

let root = Bundle.main.object(forInfoDictionaryKey: "UmmRoot") as! String
let sockPath = root + "/data/umm.sock"
let backend = Backend()

final class Backend {
    var proc: Process?, quitting = false, fails = 0, started = Date()

    func start() {
        let log = root + "/data/umm.log"
        try? FileManager.default.createDirectory(atPath: root + "/data", withIntermediateDirectories: true)
        if let n = (try? FileManager.default.attributesOfItem(atPath: log))?[.size] as? Int, n > 5_000_000 { truncate(log, 0) }
        // an orphan from a killed app would still hold the socket
        let k = Process()
        k.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
        k.arguments = ["-f", "uvicorn api:app --uds " + sockPath]
        try? k.run(); k.waitUntilExit()
        if k.terminationStatus == 0 { usleep(500_000) }
        spawn()
    }

    func spawn() {
        unlink(sockPath)
        let log = FileHandle(fileDescriptor: open(root + "/data/umm.log", O_WRONLY | O_APPEND | O_CREAT, 0o644), closeOnDealloc: true)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: root + "/backend/.venv/bin/python")
        p.arguments = ["-m", "uvicorn", "api:app", "--uds", sockPath, "--no-access-log"]
        p.currentDirectoryURL = URL(fileURLWithPath: root + "/backend")
        p.standardOutput = log
        p.standardError = log
        p.terminationHandler = { [weak self] _ in DispatchQueue.main.async { self?.died() } }
        started = Date()
        proc = p
        do { try p.run() } catch { NSLog("umm: backend failed to start: \(error)"); died() }
    }

    // restart with backoff: 1s, 2s, 4s ... 30s, reset after 30s of uptime
    func died() {
        guard !quitting else { return }
        fails = Date().timeIntervalSince(started) > 30 ? 1 : fails + 1
        DispatchQueue.main.asyncAfter(deadline: .now() + min(30, pow(2, Double(fails - 1)))) { [weak self] in
            if self?.quitting == false { self?.spawn() }
        }
    }

    func stop() {
        quitting = true
        guard let p = proc, p.isRunning else { return }
        p.terminate()
        for _ in 0..<30 where p.isRunning { usleep(100_000) }
        if p.isRunning { kill(p.processIdentifier, SIGKILL) }
        unlink(sockPath)
    }

    // one HTTP/1.1 request over the socket, nil if the backend is unreachable for `wait` seconds
    func request(_ method: String, _ target: String, headers: [String: String] = [:], body: Data = Data(), wait: Double = 30) -> (Int, [String: String], Data)? {
        let deadline = Date().addingTimeInterval(wait)
        var fd: Int32 = -1
        while true {
            fd = socket(AF_UNIX, SOCK_STREAM, 0)
            var addr = sockaddr_un()
            addr.sun_family = sa_family_t(AF_UNIX)
            withUnsafeMutableBytes(of: &addr.sun_path) { $0.copyBytes(from: sockPath.utf8.prefix($0.count - 1)) }
            let ok = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
            if ok == 0 { break }
            close(fd)
            if Date() > deadline { return nil }
            usleep(200_000)
        }
        defer { close(fd) }
        var tv = timeval(tv_sec: Int(wait) + 60, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        var head = "\(method) \(target) HTTP/1.1\r\nHost: umm\r\nConnection: close\r\nContent-Length: \(body.count)\r\n"
        for (k, v) in headers { head += "\(k): \(v)\r\n" }
        var out = Data((head + "\r\n").utf8) + body
        while !out.isEmpty {
            let n = out.withUnsafeBytes { write(fd, $0.baseAddress, out.count) }
            if n <= 0 { return nil }
            out.removeFirst(n)
        }
        var data = Data(), buf = [UInt8](repeating: 0, count: 65536)
        while true {
            let n = read(fd, &buf, buf.count)
            if n <= 0 { break }
            data.append(contentsOf: buf[..<n])
        }
        guard let split = data.firstRange(of: [13, 10, 13, 10]) else { return nil }
        let lines = String(decoding: data[..<split.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
        guard let status = lines[0].split(separator: " ").dropFirst().first.flatMap({ Int($0) }) else { return nil }
        var h: [String: String] = [:]
        for l in lines.dropFirst() {
            if let c = l.firstIndex(of: ":") { h[l[..<c].lowercased()] = l[l.index(after: c)...].trimmingCharacters(in: .whitespaces) }
        }
        var payload = data[split.upperBound...]
        if h["transfer-encoding"]?.lowercased().contains("chunked") == true {
            var d = Data(), i = payload.startIndex
            while let e = payload[i...].firstRange(of: [13, 10]),
                  let n = Int(String(decoding: payload[i..<e.lowerBound], as: UTF8.self).prefix(while: { $0 != ";" }), radix: 16),
                  n > 0, e.upperBound + n + 2 <= payload.endIndex {
                d += payload[e.upperBound..<e.upperBound + n]
                i = e.upperBound + n + 2
            }
            payload = d[...]
        }
        return (status, h, Data(payload))
    }
}
