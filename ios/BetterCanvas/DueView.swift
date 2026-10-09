// The "Due soon" tab: what's due in the next few weeks, by day, then the readings nobody has dated yet.

import SwiftUI

private let dueSoonWindow: TimeInterval = 48 * 3600
private let courseTagWidth: CGFloat = 110

private let itemTypeLabels = [
    "assignment": "Assignment", "quiz": "Quiz", "discussion_topic": "Discussion", "wiki_page": "Page",
    "planner_note": "To-do", "assessment_request": "Peer review", "reading": "Reading",
]

struct DueView: View {
    @Environment(AppStore.self) private var store
    @State private var showAll = Set<Int>() // courses where "N more" was tapped
    @State private var hiddenOpen = Set<Int>()

    var body: some View {
        NavigationStack {
            List {
                if let summary {
                    Section { Text(summary).font(.footnote).foregroundStyle(.secondary) }
                }
                dueSections
                undatedSections
            }
            .plainList()
            .navigationTitle("Due soon")
            .navigationBarTitleDisplayMode(.large)
            .navigationDestination(for: String.self) { DueDetailView(key: $0) }
            .refreshable { await store.refresh() }
            .toolbar { AccountMenu() }
            .loadingBanner()
        }
    }

    // MARK: Due list

    private var summary: LocalizedStringKey? {
        let snap = store.snapshot
        guard snap.dueError == nil, let items = snap.due, !items.isEmpty else { return nil }
        let notSubmitted = items.filter { !$0.isSubmitted && !$0.isReading }.count
        return "\(items.count) items due in the next \(snap.days) days · **\(notSubmitted)** not yet submitted"
    }

    @ViewBuilder
    private var dueSections: some View {
        let snap = store.snapshot
        if let error = snap.dueError {
            Section { Text("Couldn't load due dates: \(error)").foregroundStyle(.red) }
        } else if let items = snap.due {
            if items.isEmpty {
                Section { Text("Nothing due in the next \(snap.days) days 🎉").foregroundStyle(.secondary) }
            } else {
                ForEach(byDay(items), id: \.day) { group in
                    Section {
                        ForEach(group.items) { item in
                            NavigationLink(value: item.key) { DueRow(item: item) }
                        }
                    } header: {
                        Text("\(Dates.dayHeading(group.day)) · \(Dates.relativeDay(group.day))").compactHeading()
                    }
                }
            }
        }
    }

    private func byDay(_ items: [DueItem]) -> [(day: Date, items: [DueItem])] {
        let cal = Calendar.current
        // Within a day, open items come first and submitted ones fall to the end.
        let sorted = items.sorted { ($0.isSubmitted ? 1 : 0, $0.dueDate) < ($1.isSubmitted ? 1 : 0, $1.dueDate) }
        let groups = Dictionary(grouping: sorted) { cal.startOfDay(for: $0.dueDate) }
        return groups.keys.sorted().map { (day: $0, items: groups[$0]!) }
    }

    // MARK: Readings without a due date

    private let shown = 5

    @ViewBuilder
    private var undatedSections: some View {
        let courses = store.snapshot.undatedByCourse()
        if !courses.isEmpty {
            Section { EmptyView() } header: {
                Text("Readings without a due date")
            }
            ForEach(courses, id: \.course.id) { course, needDate, hidden in
                let expanded = showAll.contains(course.id)
                Section {
                    ForEach((expanded ? needDate : Array(needDate.prefix(shown))).indexed) { row in
                        UndatedRow(material: row.value, courseId: course.id)
                    }
                    if needDate.count > shown {
                        Button(expanded ? "Fewer" : "\(needDate.count - shown) more") {
                            if expanded { showAll.remove(course.id) } else { showAll.insert(course.id) }
                        }
                    }
                    if !hidden.isEmpty {
                        DisclosureGroup("\(hidden.count) hidden", isExpanded: Binding(
                            get: { hiddenOpen.contains(course.id) },
                            set: { if $0 { hiddenOpen.insert(course.id) } else { hiddenOpen.remove(course.id) } })
                        ) {
                            ForEach(hidden.indexed) { row in
                                UndatedRow(material: row.value, courseId: course.id)
                            }
                        }
                        .font(.footnote)
                    }
                } header: {
                    let hue = store.snapshot.hue(courseId: course.id)
                    HStack(spacing: 8) {
                        Circle().fill(Color.courseInk(hue)).frame(width: 10, height: 10).accessibilityHidden(true)
                        Text(course.name).font(.headline).foregroundStyle(Color.courseInk(hue)).textCase(nil)
                    }
                    .padding(.vertical, 4)
                }
            }
        }
    }
}

struct UndatedRow: View {
    let material: Material
    let courseId: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            MaterialRow(material: material, courseId: courseId, showDate: false, showContext: true)
            if let url = material.entry.url {
                ReadingDateControl(courseId: courseId, url: url, canHide: true).padding(.leading, 32)
            }
        }
        .padding(.vertical, 2)
    }
}

struct AccountMenu: ToolbarContent {
    @Environment(AppStore.self) private var store

    @ViewBuilder
    private var actions: some View {
        Button("Refresh", systemImage: "arrow.clockwise") { store.reload() }
        Button("Log out", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) { store.logOut() }
    }

    var body: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                if store.snapshot.user.isEmpty {
                    actions
                } else {
                    Section(store.snapshot.user) { actions }
                }
            } label: {
                Image(systemName: "person.crop.circle")
            }
        }
    }
}

struct DueRow: View {
    let item: DueItem
    @Environment(AppStore.self) private var store

    var body: some View {
        if item.isSubmitted { submittedRow } else { openRow }
    }

    /// Done items shrink to one line: they still need to be findable, but not noticed.
    private var submittedRow: some View {
        HStack(spacing: 10) {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                .accessibilityLabel(item.graded ?? false ? "Graded" : "Submitted")
            Text(item.title).strikethrough(color: .secondary).foregroundStyle(.secondary).lineLimit(1)
            Spacer(minLength: 8)
            if let id = item.courseId, let course = item.course {
                Text(course).font(.caption2).lineLimit(1)
                    .foregroundStyle(Color.courseInk(store.snapshot.hue(courseId: id)))
                    .frame(maxWidth: courseTagWidth, alignment: .trailing)
            }
        }
        .font(.subheadline)
    }

    private var openRow: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.isDateOnly ? "All day" : Dates.time(item.dueDate))
                if !item.isAssignment, let points = item.points { Text("\(points.formatted()) pts") }
            }
            .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            .frame(width: 66, alignment: .leading).padding(.top, 3)
            VStack(alignment: .leading, spacing: 4) {
                Text(item.title)
                FlowLayout(spacing: 6) {
                    if let id = item.courseId {
                        CourseTag(name: item.course ?? "", hue: store.snapshot.hue(courseId: id))
                    }
                    if !meta.isEmpty { Text(meta).font(.caption).foregroundStyle(.secondary) }
                }
            }
            Spacer(minLength: 0)
            StatusTag(item: item)
        }
    }

    /// Assignments are the common case, so only other kinds get a label; points sit under the time.
    private var meta: String {
        item.isAssignment ? "" : itemTypeLabels[item.type] ?? item.type
    }
}

struct StatusTag: View {
    let item: DueItem

    var body: some View {
        if item.isSubmitted {
            Tag(text: "✓ \(item.graded ?? false ? "Graded" : "Submitted")", foreground: .green, background: .green.opacity(0.15))
        } else if item.missing ?? false {
            Tag(text: "Missing", foreground: .red, background: .red.opacity(0.15))
        } else if item.dueDate.timeIntervalSinceNow < dueSoonWindow && !item.isReading {
            Tag(text: "Due soon", foreground: .orange, background: .orange.opacity(0.15))
        }
    }
}

// MARK: - One due item

struct DueDetailView: View {
    let key: String
    @Environment(AppStore.self) private var store

    var body: some View {
        let snap = store.snapshot
        if let item = snap.due?.first(where: { $0.key == key }) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    header(item)
                    detail(item)
                }
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationBarTitleDisplayMode(.inline)
        } else {
            ContentUnavailableView("This item is no longer on your list", systemImage: "checkmark.circle")
        }
    }

    private func header(_ item: DueItem) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(item.title).font(.title2.weight(.semibold))
            HStack(spacing: 8) {
                if let id = item.courseId {
                    CourseTag(name: item.course ?? "", hue: store.snapshot.hue(courseId: id))
                }
                Text(itemTypeLabels[item.type] ?? item.type).font(.footnote).foregroundStyle(.secondary)
                StatusTag(item: item)
            }
            Text(item.isDateOnly
                 ? "\(Dates.dayHeading(item.dueDate)) · all day"
                 : "\(Dates.dayHeading(item.dueDate)), \(Dates.time(item.dueDate))")
                .font(.subheadline).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func detail(_ item: DueItem) -> some View {
        let openLink = item.url.flatMap(URL.init(string:))
        if item.isReading, let courseId = item.courseId, let url = item.url {
            ReadingDateControl(courseId: courseId, url: url, canHide: true)
            readingLink(item, courseId: courseId)
        } else if let result = store.snapshot.details[item.key] {
            switch result {
            case let .failed(message):
                Text("Couldn't load details (\(message)).").foregroundStyle(.secondary)
                CourseWorksLink(url: openLink)
            case let .loaded(detail):
                loaded(item, detail)
            }
        } else if (item.hasDetail ?? false) && !store.snapshot.finished {
            HStack { ProgressView(); Text("Loading details…").foregroundStyle(.secondary) }
        } else if item.hasDetail ?? false {
            Text("Couldn't load details.").foregroundStyle(.secondary)
            CourseWorksLink(url: openLink)
        } else {
            Text("No further details.").foregroundStyle(.secondary)
            CourseWorksLink(url: openLink)
        }
    }

    @ViewBuilder
    private func loaded(_ item: DueItem, _ detail: DueDetail) -> some View {
        let chips = chips(detail)
        if !chips.isEmpty {
            FlowLayout { ForEach(chips, id: \.self) { Tag(text: $0) } }
        }
        if let html = detail.html, !html.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            InlineHTML(html: html)
        } else {
            Text("No description provided.").foregroundStyle(.secondary)
        }
        if !detail.files.isEmpty {
            Text("Attached files").font(.headline)
            VStack(alignment: .leading, spacing: 10) {
                ForEach(detail.files.indexed) { AttachedFileRow(file: $0.value) }
            }
        }
        let attached = Set(detail.files.compactMap(\.url))
        if let related = store.snapshot.relatedFiles(for: item, excluding: attached) {
            if !related.isEmpty, let courseId = item.courseId {
                Text("Related course files").font(.headline)
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(related.indexed) { row in
                        MaterialRow(material: row.value, courseId: courseId, showDate: false, showContext: true)
                    }
                }
            }
        } else {
            HStack { ProgressView(); Text("Looking for related course files…").font(.footnote).foregroundStyle(.secondary) }
        }
        CourseWorksLink(url: (detail.url ?? item.url).flatMap(URL.init(string:)))
    }

    private func readingLink(_ item: DueItem, courseId: Int) -> some View {
        let entry = store.snapshot.mats[courseId]?.entries.first { $0.entry.url == item.url }?.entry
        let file = entry.map { Material(entry: $0, ctx: nil) }
        return Group {
            if let file {
                MaterialRow(material: file, courseId: courseId, showDate: false)
            } else if let url = item.url.flatMap(URL.init(string:)) {
                Link("Open reading ↗", destination: url)
            }
        }
    }

    private func chips(_ d: DueDetail) -> [String] {
        var out: [String] = []
        if let p = d.points { out.append("\(p.formatted()) pts") }
        if let s = d.submission, !s.isEmpty { out.append("Submit: \(s.joined(separator: ", "))") }
        if let a = d.attempts { out.append(a == -1 ? "Unlimited attempts" : "\(Int(a)) attempt\(a == 1 ? "" : "s")") }
        if let q = d.questions { out.append("\(Int(q)) questions") }
        if let t = d.timeLimit { out.append("\(Int(t)) min limit") }
        if let u = d.unlockAt { out.append("Opens \(Dates.dateTime(u))") }
        if let l = d.lockAt { out.append("Closes \(Dates.dateTime(l))") }
        return out
    }
}
