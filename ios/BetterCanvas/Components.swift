// Small pieces shared by the screens.

import SwiftUI
import WebKit

// MARK: - Course colors (a hue per course, as in style.css)

extension Color {
    /// hsl() → a color that switches between a light and a dark variant.
    static func hsl(_ h: Double, light: (s: Double, l: Double), dark: (s: Double, l: Double)) -> Color {
        func ui(_ s: Double, _ l: Double) -> UIColor {
            let v = l + s * min(l, 1 - l)
            let sat = v == 0 ? 0 : 2 * (1 - l / v)
            return UIColor(hue: h / 360, saturation: sat, brightness: v, alpha: 1)
        }
        return Color(UIColor { $0.userInterfaceStyle == .dark ? ui(dark.s, dark.l) : ui(light.s, light.l) })
    }

    static func courseInk(_ hue: Double) -> Color { .hsl(hue, light: (0.62, 0.36), dark: (0.75, 0.74)) }
    static func courseBackground(_ hue: Double) -> Color { .hsl(hue, light: (0.75, 0.94), dark: (0.35, 0.20)) }
}

struct Tag: View {
    let text: String
    var foreground: Color = .secondary
    var background: Color = Color(.tertiarySystemFill)

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .lineLimit(1)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .foregroundStyle(foreground)
            .background(background, in: Capsule())
    }
}

struct CourseTag: View {
    let name: String
    let hue: Double

    var body: some View {
        Tag(text: name, foreground: .courseInk(hue), background: .courseBackground(hue))
            .lineLimit(1)
    }
}

struct Indexed<Value>: Identifiable {
    let id: Int
    let value: Value
}

extension Array {
    /// Rows by position, for lists whose items have no identity of their own (the same link can appear twice).
    var indexed: [Indexed<Element>] { enumerated().map { Indexed(id: $0.offset, value: $0.element) } }
}

/// The download button at the end of a file row.
struct DownloadLink: View {
    let url: URL

    var body: some View {
        Link(destination: url) { Image(systemName: "arrow.down.circle") }
            .buttonStyle(.borderless)
            .accessibilityLabel("Download")
    }
}

/// "Open in CourseWorks ↗", shown only when there is an address to open.
struct CourseWorksLink: View {
    let url: URL?

    var body: some View {
        if let url { Link("Open in CourseWorks ↗", destination: url) }
    }
}

// MARK: - Layout

/// Lays out views left to right, wrapping onto new lines (for the small fact labels).
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let result = arrange(proposal.width ?? .infinity, subviews)
        return CGSize(width: min(result.size.width, proposal.width ?? .infinity), height: result.size.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = arrange(bounds.width, subviews)
        for (subview, point) in zip(subviews, result.points) {
            subview.place(at: CGPoint(x: bounds.minX + point.x, y: bounds.minY + point.y),
                          proposal: ProposedViewSize(width: min(subview.sizeThatFits(.unspecified).width, bounds.width), height: nil))
        }
    }

    private func arrange(_ width: CGFloat, _ subviews: Subviews) -> (points: [CGPoint], size: CGSize) {
        var points: [CGPoint] = []
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, maxX: CGFloat = 0
        for subview in subviews {
            let ideal = subview.sizeThatFits(.unspecified)
            let size = CGSize(width: min(ideal.width, width), height: subview.sizeThatFits(ProposedViewSize(width: min(ideal.width, width), height: nil)).height)
            if x > 0, x + size.width > width { x = 0; y += rowHeight + spacing; rowHeight = 0 }
            points.append(CGPoint(x: x, y: y))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
            maxX = max(maxX, x - spacing)
        }
        return (points, CGSize(width: maxX, height: y + rowHeight))
    }
}

// MARK: - Loading status

/// The progress bar / result line at the top of each tab.
struct StatusBar: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        if store.phase != .idle {
            VStack(alignment: .leading, spacing: 6) {
                if !store.subtitle.isEmpty {
                    Text(store.subtitle).font(.footnote).foregroundStyle(.secondary)
                }
                HStack(spacing: 8) {
                    switch store.phase {
                    case .done: Image(systemName: "checkmark.circle.fill").foregroundStyle(.green).accessibilityHidden(true)
                    case .failed: Image(systemName: "xmark.circle.fill").foregroundStyle(.red).accessibilityHidden(true)
                    default: ProgressView().controlSize(.small)
                    }
                    Text(store.statusMessage).font(.footnote)
                }
                if store.phase == .loading {
                    ProgressView(value: store.progress)
                }
                if let error = store.loadError {
                    Text("Couldn't load data: \(error)").font(.footnote).foregroundStyle(.red)
                    Button("Try again") { store.reload() }.font(.footnote.weight(.semibold))
                }
            }
            .padding(.vertical, 2)
        }
    }
}

extension View {
    /// The plain list used on every screen, with section headings that don't take much height.
    func plainList() -> some View {
        listStyle(.plain).environment(\.defaultMinListHeaderHeight, 0)
    }

    /// Section heading text that sits close to its rows.
    func compactHeading() -> some View {
        font(.subheadline.weight(.semibold)).foregroundStyle(.secondary).textCase(nil).padding(.top, -8)
    }

    /// Loading progress and errors float over the top of the screen and go away once everything has loaded.
    func loadingBanner() -> some View { modifier(LoadingBanner()) }
}

private struct LoadingBanner: ViewModifier {
    @Environment(AppStore.self) private var store

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .top) {
                if store.phase != .idle, store.phase != .done {
                    StatusBar()
                        .padding(.horizontal, 16).padding(.vertical, 10)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                        .shadow(color: .black.opacity(0.12), radius: 10, y: 3)
                        .padding(.horizontal, 16)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .animation(.default, value: store.phase)
    }
}

// MARK: - HTML from CourseWorks (already cleaned by the server)

struct HTMLView: UIViewRepresentable {
    let html: String
    /// When set, the view reports its content height (so it can sit inside a scrolling screen) and doesn't scroll itself.
    var height: Binding<CGFloat>?

    func makeCoordinator() -> Coordinator { Coordinator(height: height) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.userContentController.add(context.coordinator, name: "height")
        let script = """
        new ResizeObserver(() => window.webkit.messageHandlers.height.postMessage(document.documentElement.scrollHeight)).observe(document.body);
        """
        config.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        let view = WKWebView(frame: .zero, configuration: config)
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        view.scrollView.isScrollEnabled = height == nil
        view.navigationDelegate = context.coordinator
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.height = height
        guard context.coordinator.loaded != html else { return }
        context.coordinator.loaded = html
        view.loadHTMLString(Self.document(html), baseURL: URL(string: "https://courseworks2.columbia.edu"))
    }

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "height")
    }

    private static func document(_ body: String) -> String {
        """
        <!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
        :root { color-scheme: light dark; }
        body { font: -apple-system-body; margin: 0; padding: 0; overflow-wrap: break-word; }
        img, video, iframe, table { max-width: 100%; height: auto; }
        pre { overflow-x: auto; }
        </style>
        <body>\(body)</body>
        """
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var height: Binding<CGFloat>?
        var loaded = ""
        init(height: Binding<CGFloat>?) { self.height = height }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let value = (message.body as? NSNumber).map({ CGFloat(truncating: $0) }), let height,
                  abs(height.wrappedValue - value) > 1 else { return }
            DispatchQueue.main.async { height.wrappedValue = value }
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            if action.navigationType == .linkActivated, let url = action.request.url {
                await UIApplication.shared.open(url)
                return .cancel
            }
            return .allow
        }
    }
}

/// Instructors' HTML at its natural height, inside a scrolling screen.
struct InlineHTML: View {
    let html: String
    @State private var height: CGFloat = 20

    var body: some View {
        HTMLView(html: html, height: $height).frame(height: height)
    }
}

/// A plain web page (document viewer, video embed).
struct WebPage: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        let view = WKWebView(frame: .zero, configuration: config)
        view.load(URLRequest(url: url))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}
}
