import AppKit
import Carbon

// Ctrl+Shift+Space opens the menu
let hotKeyCode = UInt32(kVK_Space)
let hotKeyMods = UInt32(controlKey | shiftKey)
let api = "http://localhost:8000/api/"

class Panel: NSPanel {
    override var canBecomeKey: Bool { true }
}

class Menu: NSObject, NSTextFieldDelegate, NSWindowDelegate {
    let panel = Panel(contentRect: .zero, styleMask: [.nonactivatingPanel], backing: .buffered, defer: false)
    let field = NSTextField()
    let stack = NSStackView()
    var options: [[String: Any]] = []
    var app = ""
    var selected = 0

    override init() {
        super.init()
        let bg = NSVisualEffectView()
        bg.material = .hudWindow
        bg.state = .active
        bg.wantsLayer = true
        bg.layer?.cornerRadius = 12
        panel.contentView = bg
        panel.level = .floating
        panel.backgroundColor = .clear
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.delegate = self
        field.font = .systemFont(ofSize: 18)
        field.isBezeled = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.delegate = self
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.addArrangedSubview(field)
        field.widthAnchor.constraint(equalToConstant: 560).isActive = true
        stack.translatesAutoresizingMaskIntoConstraints = false
        bg.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: bg.leadingAnchor, constant: 12),
            stack.topAnchor.constraint(equalTo: bg.topAnchor, constant: 12),
        ])
    }

    func show() {
        if panel.isVisible { return panel.orderOut(nil) }
        URLSession.shared.dataTask(with: URL(string: api + "context")!) { data, _, _ in
            let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            DispatchQueue.main.async {
                self.app = json?["app"] as? String ?? ""
                self.options = (json?["options"] as? [[String: Any]] ?? []) + [["label": "Stop umm (kills backend and this menu)", "stop": true]]
                self.field.placeholderString = json.map { "\($0["profile"]!) · type a note, or pick below" } ?? "umm backend is not running"
                self.render()
                self.panel.makeKeyAndOrderFront(nil)
            }
        }.resume()
    }

    func render() {
        stack.arrangedSubviews.dropFirst().forEach { $0.removeFromSuperview() }
        for (i, o) in options.enumerated() {
            let row = NSTextField(labelWithString: " " + (o["label"] as! String).replacingOccurrences(of: "\n", with: "  "))
            row.font = .systemFont(ofSize: 14)
            row.lineBreakMode = .byTruncatingTail
            row.tag = i
            row.wantsLayer = true
            row.layer?.cornerRadius = 5
            row.addGestureRecognizer(NSClickGestureRecognizer(target: self, action: #selector(clicked)))
            row.widthAnchor.constraint(equalToConstant: 560).isActive = true
            stack.addArrangedSubview(row)
        }
        field.stringValue = ""
        select(0)
        let size = stack.fittingSize
        panel.setContentSize(NSSize(width: size.width + 24, height: size.height + 24))
        panel.center()
        panel.makeFirstResponder(field)
    }

    func select(_ i: Int) {
        guard !options.isEmpty else { return }
        selected = (i + options.count) % options.count
        for row in stack.arrangedSubviews.dropFirst() {
            row.layer?.backgroundColor = row.tag == selected ? NSColor.controlAccentColor.withAlphaComponent(0.35).cgColor : nil
        }
    }

    @objc func clicked(_ g: NSClickGestureRecognizer) { choose(g.view!.tag) }

    func choose(_ i: Int? = nil) {
        let note = field.stringValue.trimmingCharacters(in: .whitespaces)
        panel.orderOut(nil)
        if i == nil && !note.isEmpty { return post("items", ["content": note, "app": app]) }
        guard options.indices.contains(i ?? selected) else { return }
        let o = options[i ?? selected]
        if o["stop"] != nil {
            let stop = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().appendingPathComponent("../stop.sh")
            _ = try? Process.run(stop, arguments: [])
        } else if o["capture"] != nil {
            // let the panel leave the screen before the screenshot
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { self.post("capture", [:]) }
        } else if let content = o["content"] {
            post("items", ["content": content, "app": app])
        }
    }

    func post(_ path: String, _ body: [String: Any]) {
        var req = URLRequest(url: URL(string: api + path)!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            let ok = (resp as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { NSSound(named: ok ? "Pop" : "Basso")?.play() }
        }.resume()
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        switch sel {
        case #selector(NSResponder.moveDown(_:)): select(selected + 1)
        case #selector(NSResponder.moveUp(_:)): select(selected - 1)
        // Ctrl+Shift held from the hotkey turns Return into these other newline commands
        case #selector(NSResponder.insertNewline(_:)), #selector(NSResponder.insertLineBreak(_:)),
             #selector(NSResponder.insertNewlineIgnoringFieldEditor(_:)): choose()
        case #selector(NSResponder.cancelOperation(_:)): panel.orderOut(nil)
        default: return false
        }
        return true
    }

    func windowDidResignKey(_ notification: Notification) { panel.orderOut(nil) }
}

let menu = Menu()
var hotKey: EventHotKeyRef?
var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in menu.show(); return noErr }, 1, &spec, nil, nil)
// a global hotkey fires before the frontmost app sees the keys, so umm always wins while running
RegisterEventHotKey(hotKeyCode, hotKeyMods, EventHotKeyID(signature: 0x756D6D21, id: 1), GetApplicationEventTarget(), 0, &hotKey)
NSApplication.shared.setActivationPolicy(.accessory)
NSApplication.shared.run()
