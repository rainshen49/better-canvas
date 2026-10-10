// What the server sends. These mirror the JSON from /api/data (see
// supabase/functions/api/app.ts, due.ts and materials.ts). Keys are spelled out
// in CodingKeys rather than converted automatically, because some dictionaries
// here are keyed by web addresses, which can contain underscores.

import Foundation

struct CourseSummary: Codable, Identifiable, Hashable {
    let id: Int
    let name: String
    let code: String?
    let isClass: Bool
    let url: String

    enum CodingKeys: String, CodingKey {
        case id, name, code, url
        case isClass = "is_class"
    }
}

struct DueItem: Codable, Identifiable, Hashable {
    var title: String
    var type: String
    var due: String
    var dateOnly: Bool?
    var course: String?
    var courseId: Int?
    var url: String?
    var points: Double?
    var submitted: Bool?
    var graded: Bool?
    var missing: Bool?
    var key: String
    var hasDetail: Bool?
    var addedBy: String?
    var addedAt: String?

    var id: String { key }
    var isReading: Bool { type == "reading" }
    var isAssignment: Bool { type == "assignment" }
    var isSubmitted: Bool { submitted ?? false }
    var isDateOnly: Bool { dateOnly ?? false }
    var dueDate: Date { Dates.parse(due) ?? .distantFuture }

    enum CodingKeys: String, CodingKey {
        case title, type, due, course, url, points, submitted, graded, missing, key
        case dateOnly = "date_only"
        case courseId = "course_id"
        case hasDetail = "has_detail"
        case addedBy = "added_by"
        case addedAt = "added_at"
    }
}

struct AttachedFile: Codable, Hashable {
    let id: Int?
    let name: String
    let url: String?
    let download: String?
    let preview: String?
}

struct DueDetail: Codable, Hashable {
    let html: String?
    let files: [AttachedFile]
    let points: Double?
    let submission: [String]?
    let attempts: Double?
    let timeLimit: Double?
    let questions: Double?
    let unlockAt: String?
    let lockAt: String?
    let url: String?

    enum CodingKeys: String, CodingKey {
        case html, files, points, submission, attempts, questions, url
        case timeLimit = "time_limit"
        case unlockAt = "unlock_at"
        case lockAt = "lock_at"
    }
}

enum DetailResult {
    case loaded(DueDetail)
    case failed(String)
}

/// One row in a course's modules, syllabus sections or loose files.
struct Entry: Codable, Hashable {
    let kind: String // "item" or "header"
    let title: String
    let type: String?
    let url: String?
    let cat: String?
    let fileId: Int?
    let pageUrl: String?
    let download: String?
    let folder: String?
    let mime: String?
    let preview: String?
    let embedUrl: String?

    var isHeader: Bool { kind == "header" }
    var category: Category { Category(rawValue: cat ?? "") ?? .other }
    var canPreview: Bool { preview != nil }
    var isFileOrLink: Bool { type == "File" || type == "Link" }

    enum CodingKeys: String, CodingKey {
        case kind, title, type, url, cat, download, folder, mime, preview
        case fileId = "file_id"
        case pageUrl = "page_url"
        case embedUrl = "embed_url"
    }
}

enum Category: String, CaseIterable {
    case slides, reading, video, other

    var symbol: String {
        switch self {
        case .slides: "videoprojector"
        case .reading: "doc.text"
        case .video: "film"
        case .other: "link"
        }
    }

    var label: String {
        switch self {
        case .slides: "Slides"
        case .reading: "Readings"
        case .video: "Recordings"
        case .other: "Other"
        }
    }
}

struct Module: Codable, Hashable {
    let name: String
    let items: [Entry]
}

struct QuickLink: Codable, Hashable {
    let label: String
    let url: String
}

struct Deadline: Codable, Hashable {
    var date: String // YYYY-MM-DD
    var by: String
    var at: String
    var title: String?
}

struct Discussed: Codable, Hashable {
    var by: String
    var at: String
    var title: String?
}

struct CourseMaterials: Decodable {
    let id: Int
    let name: String
    let code: String?
    let isClass: Bool
    let url: String
    let modules: [Module]
    let quick: [QuickLink]
    let files: [Entry]
    var deadlines: [String: Deadline]
    var discussed: [String: Discussed]
    /// Every file and link, with the module or folder it sits in. Built once, when the course is decoded.
    let entries: [Material]

    enum CodingKeys: String, CodingKey {
        case id, name, code, url, modules, quick, files, deadlines, discussed
        case isClass = "is_class"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        code = try c.decodeIfPresent(String.self, forKey: .code)
        isClass = try c.decode(Bool.self, forKey: .isClass)
        url = try c.decode(String.self, forKey: .url)
        modules = try c.decode([Module].self, forKey: .modules)
        quick = try c.decode([QuickLink].self, forKey: .quick)
        files = try c.decode([Entry].self, forKey: .files)
        deadlines = try c.decode([String: Deadline].self, forKey: .deadlines)
        discussed = try c.decode([String: Discussed].self, forKey: .discussed)
        entries = modules.flatMap { module in
            module.items.filter { !$0.isHeader }.map { Material(entry: $0, ctx: module.name) }
        } + files.map { Material(entry: $0, ctx: $0.folder) }
    }
}

/// An entry together with where it was found.
struct Material: Hashable {
    let entry: Entry
    let ctx: String?
}

/// Result of POST /api/reading-deadline.
struct ReadingState: Decodable {
    let deadline: Deadline?
    let discussed: Discussed?
    let error: String?
    let needToken: Bool?

    enum CodingKeys: String, CodingKey {
        case deadline, discussed, error
        case needToken = "need_token"
    }
}

/// A short note a classmate left on a due item.
struct ItemNote: Codable, Hashable {
    let note: String
    let by: String
    let at: String
}

/// Result of POST /api/note: the item's new note, or none if it was deleted.
struct NoteState: Decodable {
    let note: ItemNote?
    let error: String?
    let needToken: Bool?

    enum CodingKeys: String, CodingKey {
        case note, error
        case needToken = "need_token"
    }
}

/// The server's error body: {"error": …, "need_token": true?}, plus the course id on a stream failure.
struct ServerFailure: Decodable {
    let error: String?
    let id: Int?
    let needToken: Bool?

    enum CodingKeys: String, CodingKey {
        case error, id
        case needToken = "need_token"
    }
}

struct FilePreviewInfo: Decodable {
    let name: String?
    let kind: String
    let src: String?
    let viewerUrl: String?

    enum CodingKeys: String, CodingKey {
        case name, kind, src
        case viewerUrl = "viewer_url"
    }
}

struct PageContent: Decodable {
    let title: String?
    let html: String?
}

// MARK: - Stream events

enum StreamEvent {
    case start(user: String, days: Int, courses: [CourseSummary])
    case due([DueItem])
    case dueError(String)
    case dueDetail(key: String, result: DetailResult)
    case notes([String: ItemNote])
    case notesError(String)
    case course(CourseMaterials)
    case courseError(id: Int?, message: String)
    case done(Date)

    var isError: Bool {
        switch self {
        case .dueError, .courseError: true
        default: false
        }
    }

    private struct Probe: Decodable { let type: String }
    private struct Start: Decodable { let user: String?; let days: Int; let courses: [CourseSummary] }
    private struct Due: Decodable { let due: [DueItem] }
    private struct Detail: Decodable { let key: String; let detail: DueDetail?; let error: String? }
    private struct Notes: Decodable { let notes: [String: ItemNote] }
    private struct One: Decodable { let course: CourseMaterials }
    private struct Done: Decodable { let generated: String? }

    /// Reads one line of the stream. Throws if the line isn't an update this app understands.
    static func parse(_ line: String) throws -> StreamEvent {
        let data = Data(line.utf8)
        let decoder = JSONDecoder()
        switch try decoder.decode(Probe.self, from: data).type {
        case "start":
            let s = try decoder.decode(Start.self, from: data)
            return .start(user: s.user ?? "", days: s.days, courses: s.courses)
        case "due":
            return .due(try decoder.decode(Due.self, from: data).due)
        case "due_error":
            return .dueError(try decoder.decode(ServerFailure.self, from: data).error ?? "unknown error")
        case "due_detail":
            let d = try decoder.decode(Detail.self, from: data)
            if let detail = d.detail { return .dueDetail(key: d.key, result: .loaded(detail)) }
            return .dueDetail(key: d.key, result: .failed(d.error ?? "unknown error"))
        case "notes":
            return .notes(try decoder.decode(Notes.self, from: data).notes)
        case "notes_error":
            return .notesError(try decoder.decode(ServerFailure.self, from: data).error ?? "unknown error")
        case "course":
            return .course(try decoder.decode(One.self, from: data).course)
        case "course_error":
            let f = try decoder.decode(ServerFailure.self, from: data)
            return .courseError(id: f.id, message: f.error ?? "unknown error")
        case "done":
            let d = try decoder.decode(Done.self, from: data)
            return .done(d.generated.flatMap(Dates.parse) ?? Date())
        default:
            throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "unknown update"))
        }
    }
}
