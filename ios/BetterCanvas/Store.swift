// The app's state, following static/app.js: the server streams updates, and the
// app changes as each one arrives. The last complete set of updates is kept on
// the phone and shown straight away (marked as saved) while fresh data loads.

import CryptoKit
import Foundation
import Observation

// MARK: - Everything the server has sent for one load

struct Snapshot {
    var started = false
    var user = ""
    var days = 21
    var courses: [CourseSummary] = []
    var due: [DueItem]?
    var dueError: String?
    var details: [String: DetailResult] = [:]
    /// Item key → its note. Nil until the server has sent them (or if this saved copy predates notes).
    var notes: [String: ItemNote]?
    var notesError: String?
    var mats: [Int: CourseMaterials] = [:]
    var courseErrors: [Int: String] = [:]
    var got = 0
    var total = 0
    var finished = false
    var generated: Date?

    var classes: [CourseSummary] { courses.filter(\.isClass) }
    var otherSites: [CourseSummary] { courses.filter { !$0.isClass } }

    mutating func apply(_ event: StreamEvent) {
        switch event {
        case let .start(user, days, courses):
            self = Snapshot()
            started = true
            self.user = user
            self.days = days
            self.courses = courses
            total = courses.count + 2 // the due list, the notes + one per course; due details are added later
        case let .due(items):
            due = items
            total += items.filter { $0.hasDetail ?? false }.count
            got += 1
        case let .dueDetail(key, result):
            details[key] = result
            got += 1
        case let .dueError(message):
            dueError = message
            got += 1
        case let .notes(all):
            notes = all
            got += 1
        case let .notesError(message):
            notesError = message
            got += 1
        case let .course(course):
            mats[course.id] = course
            got += 1
        case let .courseError(id, message):
            if let id { courseErrors[id] = message }
            got += 1
        case let .done(date):
            finished = true
            generated = date
        }
    }

    /// Put an item's note (or, if nil, its absence) in place.
    mutating func setNote(key: String, _ note: ItemNote?) {
        notes?[key] = note
    }

    // MARK: Reading state (shared with everyone in the course)

    /// A reading is in one of three states: it has a due date, it's hidden (discussed in class, so it
    /// needs none), or neither, so it's listed under "Readings without a due date".
    mutating func setReading(courseId: Int, url: String, deadline: Deadline?, discussed: Discussed?) {
        guard var course = mats[courseId] else { return }
        course.deadlines[url] = deadline
        course.discussed[url] = discussed
        mats[courseId] = course
        updateDueList(courseId: courseId, url: url, deadline: deadline)
    }

    /// Add, move or remove a reading in the "Due soon" list after its date changes.
    private mutating func updateDueList(courseId: Int, url: String, deadline: Deadline?) {
        guard var items = due else { return }
        let key = "reading:\(courseId):\(url)"
        items.removeAll { $0.key == key }
        if let deadline, deadline.date >= Dates.dayFromToday(0), deadline.date <= Dates.dayFromToday(days) {
            items.append(DueItem(
                title: deadline.title ?? "", type: "reading", due: deadline.date + "T00:00:00", dateOnly: true,
                course: courses.first { $0.id == courseId }?.name ?? "", courseId: courseId, url: url,
                submitted: false, graded: false, missing: false, key: key, hasDetail: false,
                addedBy: deadline.by, addedAt: deadline.at))
        }
        due = items
    }

    func title(courseId: Int, url: String) -> String {
        guard let course = mats[courseId] else { return "" }
        return course.deadlines[url]?.title ?? course.discussed[url]?.title
            ?? course.entries.first { $0.entry.url == url }?.entry.title ?? ""
    }

    // MARK: Lookups

    func hue(courseId: Int) -> Double {
        let hues: [Double] = [212, 150, 28, 282, 350, 184, 48, 250, 100, 322]
        let index = courses.firstIndex { $0.id == courseId } ?? 0
        return hues[index % hues.count]
    }

    /// A class's readings, split into those still needing a date and those hidden. Each link counts once.
    func undatedReadings(_ course: CourseMaterials) -> (needDate: [Material], hidden: [Material]) {
        var seen = Set<String>()
        var need: [Material] = [], hidden: [Material] = []
        for m in course.entries where m.entry.category == .reading {
            guard let url = m.entry.url, seen.insert(url).inserted else { continue }
            if course.discussed[url] != nil { hidden.append(m) } else if course.deadlines[url] == nil { need.append(m) }
        }
        return (need, hidden)
    }

    /// The classes with readings to list, in the same order as the Slides & readings tab.
    func undatedByCourse() -> [(course: CourseMaterials, needDate: [Material], hidden: [Material])] {
        classes.compactMap { mats[$0.id] }.compactMap { course in
            let r = undatedReadings(course)
            return r.needDate.isEmpty && r.hidden.isEmpty ? nil : (course, r.needDate, r.hidden)
        }
    }

    /// Course files (and syllabus links) that mention the same assignment number as `item`, e.g. "HW02" ↔ HW2.pdf.
    /// Files already attached to the assignment are left out. Nil if the course hasn't loaded yet.
    func relatedFiles(for item: DueItem, excluding urls: Set<String>) -> [Material]? {
        let wanted = AssignmentMatch.ids(in: item.title)
        guard !wanted.isEmpty else { return [] }
        guard let id = item.courseId, let course = mats[id] else { return nil }
        return course.entries.filter { m in
            guard m.entry.isFileOrLink, !urls.contains(m.entry.url ?? "") else { return false }
            return !wanted.isDisjoint(with: AssignmentMatch.ids(in: m.entry.title + " " + (m.ctx ?? "")))
        }
    }
}

enum AssignmentMatch {
    private static let regex = try! NSRegularExpression(
        pattern: #"(?<![a-z])(hw|homework|assignment|problem set|ps|lab|project)\s*#?\s*0*(\d+)(?!\d)"#,
        options: .caseInsensitive)
    private static let kinds = ["homework": "hw", "hw": "hw", "problem set": "ps", "ps": "ps",
                                "assignment": "assignment", "lab": "lab", "project": "project"]

    /// Assignment numbers in some text, written the same way: "Homework 2" and "HW02" both become "hw2".
    static func ids(in text: String) -> Set<String> {
        let ns = text as NSString
        var out = Set<String>()
        for m in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            let kind = ns.substring(with: m.range(at: 1)).lowercased()
            out.insert((kinds[kind] ?? kind) + ns.substring(with: m.range(at: 2)))
        }
        return out
    }
}

enum ReadingChange {
    case setDate(String), removeDate, hide(Bool)
}

// MARK: - The store

@MainActor @Observable
final class AppStore {
    enum Phase { case idle, loading, done, failed }

    private(set) var token: String
    private(set) var authMessage: String?

    private(set) var snapshot = Snapshot()
    private(set) var phase = Phase.idle
    private(set) var statusMessage = ""
    private(set) var loadError: String?

    // Screen state
    var query = ""
    var filter: Category?

    // Reading changes in progress, and the last error for each reading
    private(set) var savingReadings = Set<String>()
    private(set) var readingErrors: [String: String] = [:]
    // Notes being saved, and the last error for each item's note
    private(set) var savingNotes = Set<String>()
    private(set) var noteErrors: [String: String] = [:]

    private var loadTask: Task<Void, Never>?
    private var generation = 0
    private var session = 0 // changes on log out, so saves still in flight don't touch the next person's data
    /// While a saved copy (or the previous load) is on screen, fresh updates are collected here and swapped in when done.
    private var pending: Snapshot?
    private var savedAt: Date?
    private var previews: [String: LoadedPreview] = [:]
    private var previewOrder: [String] = []
    private static let previewLimit = 6 // PDFs are kept in memory, so only the latest few are

    var isLoggedIn: Bool { !token.isEmpty }
    var client: APIClient { APIClient(token: token) }

    init() {
        token = Keychain.read()
        UserDefaults.standard.removeObject(forKey: "server") // an older version let people choose a server
        #if DEBUG
        // For testing in the simulator: `defaults write <bundle id> debugToken <token>` logs in without typing.
        if !isLoggedIn, let t = UserDefaults.standard.string(forKey: "debugToken"), !t.isEmpty { token = t }
        #endif
        if isLoggedIn { reload() }
    }

    // MARK: Login

    func logIn(token: String) {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        self.token = trimmed
        Keychain.write(trimmed)
        authMessage = nil
        reload()
    }

    func logOut(message: String? = nil) {
        generation += 1
        session += 1
        loadTask?.cancel()
        token = ""
        savingReadings = []
        readingErrors = [:]
        savingNotes = []
        noteErrors = [:]
        savedAt = nil
        Keychain.write("")
        Cache.clear()
        snapshot = Snapshot()
        pending = nil
        previews = [:]
        previewOrder = []
        phase = .idle
        loadError = nil
        authMessage = message
    }

    // MARK: Loading

    /// Starts a load and returns when it has finished (so pull-to-refresh can wait for it).
    func refresh() async {
        reload()
        await loadTask?.value
    }

    func reload() {
        guard isLoggedIn else { return }
        loadTask?.cancel()
        generation += 1
        let gen = generation
        loadTask = Task { await run(generation: gen) }
    }

    private func run(generation gen: Int) async {
        let token = self.token
        loadError = nil

        // Show the saved copy, if there's a recent one, while the fresh data loads.
        if !snapshot.started, let saved = Cache.read(token: token) {
            var copy = Snapshot()
            for line in saved.events { if let e = try? StreamEvent.parse(line) { copy.apply(e) } }
            if copy.started {
                snapshot = copy
                savedAt = saved.savedAt
            }
        }
        let buffering = snapshot.started
        pending = buffering ? Snapshot() : nil
        if !buffering { snapshot = Snapshot() }
        phase = .loading
        statusMessage = buffering ? "Refreshing from CourseWorks…" : "Connecting to CourseWorks…"

        var lines: [String] = []
        var finished = false
        var hadError = false
        var unreadUpdates = 0
        do {
            for try await line in client.dataLines() {
                guard gen == generation else { return }
                guard let event = try? StreamEvent.parse(line) else {
                    hadError = true // an update was lost, so this load isn't worth saving
                    unreadUpdates += 1
                    continue
                }
                lines.append(line)
                if buffering { pending?.apply(event) } else { snapshot.apply(event) }
                updateStatus(buffering: buffering)
                if case .done = event { finished = true }
                if event.isError { hadError = true }
            }
        } catch is CancellationError {
            return
        } catch {
            guard gen == generation else { return }
            if (error as? APIError)?.needToken == true {
                return logOut(message: (error as? APIError)?.message)
            }
            return fail(error.localizedDescription, buffering: buffering)
        }
        guard gen == generation else { return }
        guard finished else { return fail("the response ended early.", buffering: buffering) }

        // Only a load where everything arrived is worth saving.
        let complete = !hadError
        if complete { Cache.write(token: token, events: lines) }
        if let fresh = pending { snapshot = fresh }
        pending = nil
        savedAt = nil
        let total = snapshot.courses.count
        let failed = snapshot.courseErrors.count
        phase = (failed > 0 && !complete) || unreadUpdates > 0 ? .failed : .done
        statusMessage = failed > 0 ? "\(total - failed) of \(total) courses loaded" : "All \(total) courses loaded"
        if unreadUpdates > 0 {
            statusMessage += ". \(unreadUpdates) update\(unreadUpdates == 1 ? "" : "s") couldn't be read."
        }
    }

    private func savedNote() -> String { savedAt.map { "saved \(Dates.timeAgo($0))" } ?? "saved earlier" }

    private func updateStatus(buffering: Bool) {
        let s = buffering ? pending! : snapshot
        guard !s.finished else { return }
        let progress = s.total > s.got ? "\(s.got) of \(s.total) ready" : "finishing up…"
        statusMessage = buffering ? "Refreshing… \(progress)" : "Loading from CourseWorks… \(progress)"
    }

    private func fail(_ message: String, buffering: Bool) {
        pending = nil
        phase = .failed
        loadError = message
        statusMessage = buffering ? "Couldn't refresh. Showing data \(savedNote())." : "Stopped loading."
    }

    /// 0…1 for the progress bar.
    var progress: Double {
        let s = pending ?? snapshot
        return s.total > 0 ? max(0.03, Double(s.got) / Double(s.total)) : 0.03
    }

    var subtitle: String {
        guard snapshot.started else { return phase == .loading ? "Connecting…" : "" }
        var parts = ["\(snapshot.courses.count) courses"]
        if let generated = snapshot.generated, phase != .loading {
            parts.append("updated \(Dates.time(generated))")
        } else if phase == .loading, savedAt != nil {
            parts.append(savedNote())
        }
        return parts.joined(separator: " · ")
    }

    // MARK: Reading due dates and hiding

    func readingKey(_ courseId: Int, _ url: String) -> String { "\(courseId) \(url)" }

    func deadline(_ courseId: Int, _ url: String) -> Deadline? { snapshot.mats[courseId]?.deadlines[url] }
    func discussed(_ courseId: Int, _ url: String) -> Discussed? { snapshot.mats[courseId]?.discussed[url] }

    /// Give a reading a day, remove its day, or hide/unhide it. The screen updates right away, and
    /// goes back to what the server last saved if the server refuses.
    func changeReading(courseId: Int, url: String, _ action: ReadingChange) {
        let key = readingKey(courseId, url)
        guard !savingReadings.contains(key) else { return }
        guard pending == nil else {
            readingErrors[key] = "Still refreshing. Try again in a moment."
            return
        }
        readingErrors[key] = nil

        let before = (deadline(courseId, url), discussed(courseId, url))
        let me = (by: snapshot.user.isEmpty ? "You" : snapshot.user, at: ISO8601DateFormatter().string(from: Date()),
                  title: snapshot.title(courseId: courseId, url: url))
        var change: [String: Any] = [:]
        switch action {
        case let .hide(hide):
            change["discussed"] = hide
            snapshot.setReading(courseId: courseId, url: url, deadline: nil,
                                discussed: hide ? Discussed(by: me.by, at: me.at, title: me.title) : nil)
        case let .setDate(date):
            change["date"] = date
            snapshot.setReading(courseId: courseId, url: url,
                                deadline: Deadline(date: date, by: me.by, at: me.at, title: me.title), discussed: nil)
        case .removeDate:
            change["date"] = NSNull()
            snapshot.setReading(courseId: courseId, url: url, deadline: nil, discussed: nil)
        }

        savingReadings.insert(key)
        let client = self.client
        let session = self.session
        Task {
            do {
                let state = try await client.changeReading(courseId: courseId, url: url, change: change)
                guard session == self.session else { return } // logged out meanwhile
                savingReadings.remove(key)
                snapshot.setReading(courseId: courseId, url: url, deadline: state.deadline, discussed: state.discussed)
            } catch {
                guard session == self.session else { return }
                savingReadings.remove(key)
                snapshot.setReading(courseId: courseId, url: url, deadline: before.0, discussed: before.1)
                if (error as? APIError)?.needToken == true { return logOut(message: error.localizedDescription) }
                readingErrors[key] = "Not saved: \(error.localizedDescription)"
            }
        }
    }

    // MARK: Notes

    /// Save an item's note for everyone in its course, or delete it (nil). Unlike due dates, the screen
    /// changes once the server has answered.
    func saveNote(_ item: DueItem, _ text: String?) {
        guard let courseId = item.courseId else { return }
        let key = item.key
        guard !savingNotes.contains(key) else { return }
        guard pending == nil else {
            noteErrors[key] = "Still refreshing. Try again in a moment."
            return
        }
        noteErrors[key] = nil
        savingNotes.insert(key)
        let client = self.client
        let session = self.session
        Task {
            do {
                let saved = try await client.saveNote(courseId: courseId, key: key, note: text)
                guard session == self.session else { return }
                savingNotes.remove(key)
                snapshot.setNote(key: key, saved)
            } catch {
                guard session == self.session else { return }
                savingNotes.remove(key)
                if (error as? APIError)?.needToken == true { return logOut(message: error.localizedDescription) }
                noteErrors[key] = "Not saved: \(error.localizedDescription)"
            }
        }
    }

    func clearNoteError(_ key: String) { noteErrors[key] = nil }

    // MARK: Previews

    func cachedPreview(_ key: String) -> LoadedPreview? { previews[key] }
    func cachePreview(_ key: String, _ preview: LoadedPreview) {
        previewOrder.removeAll { $0 == key }
        previewOrder.append(key)
        previews[key] = preview
        while previewOrder.count > Self.previewLimit { previews[previewOrder.removeFirst()] = nil }
    }
}

// MARK: - Saved copy of the last complete load

enum Cache {
    private static let version = 1
    private static let maxAge: TimeInterval = 24 * 3600

    struct Saved: Codable { var version = Cache.version; var token: String; var savedAt: Date; var events: [String] }

    private static var url: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("saved-load.json")
    }

    /// A short fingerprint of the token, so one person's saved data isn't shown to another.
    private static func fingerprint(_ token: String) -> String {
        SHA256.hash(data: Data(token.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    static func read(token: String) -> Saved? {
        guard let data = try? Data(contentsOf: url),
              let saved = try? JSONDecoder().decode(Saved.self, from: data) else { return nil }
        let age = Date().timeIntervalSince(saved.savedAt)
        guard saved.version == version, saved.token == fingerprint(token), age >= 0, age < maxAge else {
            clear()
            return nil
        }
        return saved
    }

    static func write(token: String, events: [String]) {
        let saved = Saved(token: fingerprint(token), savedAt: Date(), events: events)
        if let data = try? JSONEncoder().encode(saved) { try? data.write(to: url, options: .atomic) }
    }

    static func clear() { try? FileManager.default.removeItem(at: url) }
}
