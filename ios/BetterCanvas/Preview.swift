// Previewing a file, page or video inside the app (see "Previews" in static/app.js).

import AVKit
import PDFKit
import SwiftUI

/// How the server says an entry can be shown (entry.preview).
enum PreviewKind: String {
    case pdf, office, image, video, audio, text, auto, page, embed
}

struct PreviewTarget: Identifiable {
    let id = UUID()
    let title: String
    let kind: PreviewKind
    var fileId: Int?
    var embed: String?
    var pageUrl: String?
    var courseId: Int?
    var url: String?

    init(entry: Entry, courseId: Int?) {
        title = entry.title
        kind = entry.preview.flatMap(PreviewKind.init) ?? .auto
        fileId = entry.fileId
        embed = entry.embedUrl
        pageUrl = entry.pageUrl
        self.courseId = courseId
        url = entry.url
    }

    init?(file: AttachedFile) {
        guard let preview = file.preview, let id = file.id else { return nil }
        title = file.name
        kind = PreviewKind(rawValue: preview) ?? .auto
        fileId = id
        url = file.url
    }

    var cacheKey: String {
        if let fileId { return "file:\(fileId)" }
        if let embed { return "embed:\(embed)" }
        return "page:\(courseId ?? 0)/\(pageUrl ?? "")"
    }
}

enum LoadedPreview {
    case pdf(Data)
    case web(URL)
    case image(URL)
    case media(URL)
    case text(String, cut: Bool)
    case page(String)
    case unavailable
}

private let maxTextPreview = 200_000 // bytes

struct PreviewSheet: View {
    let target: PreviewTarget
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var loaded: LoadedPreview?
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            Group {
                if let loaded {
                    content(loaded)
                } else if let failure {
                    ContentUnavailableView {
                        Label("Couldn't load the preview", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(failure)
                    } actions: {
                        if let link = original { Link("Open original", destination: link) }
                    }
                } else {
                    ProgressView("Loading preview…")
                }
            }
            .navigationTitle(target.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                if let link = original {
                    ToolbarItem(placement: .secondaryAction) { Link("Open in CourseWorks", destination: link) }
                }
            }
        }
        .task { await load() }
    }

    private var original: URL? { target.url.flatMap(URL.init(string:)) }

    @ViewBuilder
    private func content(_ preview: LoadedPreview) -> some View {
        switch preview {
        case let .pdf(data): PDFContent(data: data).ignoresSafeArea(edges: .bottom)
        case let .web(url): WebPage(url: url).ignoresSafeArea(edges: .bottom)
        case let .image(url):
            ScrollView([.horizontal, .vertical]) {
                AsyncImage(url: url) { $0.resizable().scaledToFit() } placeholder: { ProgressView() }
            }
        case let .media(url): MediaPlayer(url: url)
        case let .text(text, cut):
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text(text).font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
                    if cut { Text("Only the beginning of this file is shown.").font(.footnote).foregroundStyle(.secondary) }
                }
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        case let .page(html):
            if html.isEmpty {
                ContentUnavailableView("This page is empty", systemImage: "doc")
            } else {
                HTMLView(html: html).padding(.horizontal)
            }
        case .unavailable:
            ContentUnavailableView {
                Label("No preview for this file", systemImage: "eye.slash")
            } actions: {
                if let link = original { Link("Open in CourseWorks", destination: link) }
            }
        }
    }

    private func load() async {
        if let cached = store.cachedPreview(target.cacheKey) { loaded = cached; return }
        do {
            let preview = try await fetch()
            store.cachePreview(target.cacheKey, preview)
            loaded = preview
        } catch is CancellationError {
        } catch {
            if (error as? APIError)?.needToken == true { store.logOut(message: error.localizedDescription) }
            failure = error.localizedDescription
        }
    }

    private func fetch() async throws -> LoadedPreview {
        let client = store.client
        if target.kind == .embed {
            guard let src = target.embed.flatMap(URL.init(string:)) else { return .unavailable }
            return .web(src)
        }
        if target.kind == .page {
            let page: PageContent = try await client.get("/api/page", query: [
                "course_id": String(target.courseId ?? 0), "page_url": target.pageUrl ?? "",
            ])
            return .page(page.html ?? "")
        }
        // A file: ask the server how it can be shown.
        guard let fileId = target.fileId else { return .unavailable }
        let id = String(fileId)
        let info: FilePreviewInfo = try await client.get("/api/file-preview", query: ["file_id": id])
        let src = (info.src ?? info.viewerUrl).flatMap(URL.init(string:))
        switch info.kind {
        case "pdf": return .pdf(try await client.bytes("/api/file-content", query: ["file_id": id]))
        case "text":
            let data = try await client.bytes("/api/file-content", query: ["file_id": id])
            return .text(String(decoding: data.prefix(maxTextPreview), as: UTF8.self), cut: data.count > maxTextPreview)
        case "viewer": return src.map(LoadedPreview.web) ?? .unavailable
        case "image": return src.map(LoadedPreview.image) ?? .unavailable
        case "video", "audio": return src.map(LoadedPreview.media) ?? .unavailable
        default: return .unavailable
        }
    }
}

struct PDFContent: UIViewRepresentable {
    let data: Data

    func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.document = PDFDocument(data: data)
        return view
    }

    func updateUIView(_ view: PDFView, context: Context) {}
}

struct MediaPlayer: View {
    let url: URL
    @State private var player: AVPlayer?

    var body: some View {
        VideoPlayer(player: player)
            .onAppear { player = AVPlayer(url: url) }
            .onDisappear { player?.pause() }
    }
}
