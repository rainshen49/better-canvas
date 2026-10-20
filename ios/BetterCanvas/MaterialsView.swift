// The "Slides & readings" tab: every class's slides, readings and recordings, searchable.

import SwiftUI

struct MaterialsView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        @Bindable var store = store
        NavigationStack {
            List {
                if store.query.isEmpty {
                    courseList
                } else {
                    searchResults
                }
            }
            .plainList()
            .loadingBanner()
            .navigationTitle("Slides & readings")
            .navigationDestination(for: Int.self) { CourseView(courseId: $0) }
            .searchable(text: $store.query, prompt: "Search slides and readings")
            .refreshable { await store.refresh() }
            .toolbar {
                AccountMenu()
                ToolbarItem(placement: .topBarLeading) { FilterMenu() }
            }
        }
    }

    // MARK: Courses

    @ViewBuilder
    private var courseList: some View {
        let snap = store.snapshot
        if snap.started {
            if snap.classes.isEmpty {
                Section { Text("No active classes found.").foregroundStyle(.secondary) }
            } else {
                Section {
                    ForEach(snap.classes) { CourseRow(course: $0) }
                } header: {
                    Text("Classes · \(snap.classes.count)").compactHeading()
                }
            }
            if !snap.otherSites.isEmpty {
                Section {
                    DisclosureGroup("Other sites (orientation, career…) · \(snap.otherSites.count)") {
                        ForEach(snap.otherSites) { CourseRow(course: $0) }
                    }
                }
            }
        }
    }

    // MARK: Search

    @ViewBuilder
    private var searchResults: some View {
        let results = matches
        if results.isEmpty {
            Section { Text("Nothing matches “\(store.query)”.").foregroundStyle(.secondary) }
        }
        ForEach(results, id: \.course.id) { result in
            Section {
                ForEach(result.items.indexed) { row in
                    MaterialRow(material: row.value, courseId: result.course.id, showContext: true)
                }
            } header: {
                CourseTag(name: result.course.name, hue: store.snapshot.hue(courseId: result.course.id)).padding(.vertical, 4)
            }
        }
    }

    private var matches: [(course: CourseSummary, items: [Material])] {
        let query = store.query.trimmingCharacters(in: .whitespaces).lowercased()
        return store.snapshot.courses.compactMap { course in
            guard let mats = store.snapshot.mats[course.id] else { return nil }
            let items = mats.entries.filter { Self.matches($0, filter: store.filter, query: query) }
            return items.isEmpty ? nil : (course, items)
        }
    }

    /// An entry shows if it is in the chosen category and its title or folder contains the search text.
    static func matches(_ m: Material, filter: Category?, query: String) -> Bool {
        if let filter, m.entry.category != filter { return false }
        guard !query.isEmpty else { return true }
        return (m.entry.title + " " + (m.entry.folder ?? "")).lowercased().contains(query)
    }
}

struct FilterMenu: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        @Bindable var store = store
        Menu {
            Picker("Show", selection: $store.filter) {
                Text("All").tag(Category?.none)
                ForEach(Category.allCases, id: \.self) { Label($0.label, systemImage: $0.symbol).tag(Category?.some($0)) }
            }
        } label: {
            Image(systemName: store.filter == nil ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
        }
    }
}

struct CourseRow: View {
    let course: CourseSummary
    @Environment(AppStore.self) private var store

    var body: some View {
        let snap = store.snapshot
        let hue = snap.hue(courseId: course.id)
        if let mats = snap.mats[course.id] {
            NavigationLink(value: course.id) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(course.name).font(.headline)
                    FlowLayout {
                        if let code = course.code { Tag(text: code) }
                        let slides = mats.entries.filter { $0.entry.category == .slides }.count
                        let readings = mats.entries.filter { $0.entry.category == .reading }.count
                        Tag(text: "\(slides) \(slides == 1 ? "slide" : "slides")",
                            foreground: .courseInk(hue), background: .courseBackground(hue))
                        Tag(text: "\(readings) \(readings == 1 ? "reading" : "readings")",
                            foreground: .courseInk(hue), background: .courseBackground(hue))
                    }
                }
            }
        } else if let error = snap.courseErrors[course.id] {
            VStack(alignment: .leading) {
                Text(course.name)
                Text("couldn't load: \(error)").font(.footnote).foregroundStyle(.red)
            }
        } else {
            HStack { ProgressView(); Text(course.name); Text("loading…").foregroundStyle(.secondary) }
        }
    }
}

/// One course: shortcut links, then its modules and files.
struct CourseView: View {
    let courseId: Int
    @Environment(AppStore.self) private var store

    var body: some View {
        if let course = store.snapshot.mats[courseId] {
            List {
                if !course.quick.isEmpty {
                    Section {
                        FlowLayout(spacing: 8) {
                            ForEach(course.quick, id: \.url) { link in
                                if let url = URL(string: link.url) {
                                    let isVideo = link.label.range(of: "echo|video|zoom", options: [.regularExpression, .caseInsensitive]) != nil
                                    Link(destination: url) { Label(link.label, systemImage: isVideo ? "play.rectangle" : "link").labelStyle(.titleAndIcon) }
                                        .buttonStyle(.bordered)
                                        .fixedSize()
                                }
                            }
                        }
                    }
                }
                if !course.teams.isEmpty {
                    Section("Your teams") {
                        ForEach(course.teams) { team in
                            DisclosureGroup {
                                ForEach(team.members, id: \.self) { member in
                                    VStack(alignment: .leading) {
                                        Text(member.name)
                                        if let email = member.email {
                                            Text(email).font(.footnote).foregroundStyle(.secondary)
                                        }
                                    }
                                }
                                CopyEmailsButton(emails: team.emails, title: "Copy emails")
                            } label: {
                                Label("\(team.name) · \(team.members.count)", systemImage: "person.2")
                            }
                        }
                    }
                }
                ForEach(course.modules.indexed) { module in
                    moduleSection(module.value, course)
                }
                looseFiles(course)
                if course.modules.isEmpty && course.files.isEmpty {
                    Section {
                        Text("No modules or files are visible for this course.").foregroundStyle(.secondary)
                    }
                }
                Section { CourseWorksLink(url: URL(string: course.url)) }
            }
            .plainList()
            .navigationTitle(course.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text(course.name).font(.subheadline.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.7)
                }
                ToolbarItem(placement: .topBarTrailing) { FilterMenu() }
            }
        } else {
            ProgressView()
        }
    }

    /// Rows of a module, with its subheadings. Rows outside the chosen category are hidden, and so are
    /// subheadings with nothing left under them.
    private func moduleSection(_ module: Module, _ course: CourseMaterials) -> some View {
        var rows: [(header: String?, entry: Entry?)] = []
        var pendingHeader: String?
        for entry in module.items {
            if entry.isHeader { pendingHeader = entry.title; continue }
            guard MaterialsView.matches(Material(entry: entry, ctx: module.name), filter: store.filter, query: "") else { continue }
            if let header = pendingHeader { rows.append((header, nil)); pendingHeader = nil }
            rows.append((nil, entry))
        }
        return Group {
            if !rows.isEmpty {
                Section {
                    ForEach(rows.indexed) { indexed in
                        let row = indexed.value
                        if let header = row.header {
                            Text(header).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                        } else if let entry = row.entry {
                            MaterialRow(material: Material(entry: entry, ctx: module.name), courseId: course.id)
                        }
                    }
                } header: {
                    Text(module.name).compactHeading()
                }
            }
        }
    }

    /// Files not linked from a module or the syllabus: in a course with modules they follow the modules as
    /// they are; otherwise they're grouped by folder.
    @ViewBuilder
    private func looseFiles(_ course: CourseMaterials) -> some View {
        let files = course.files.filter { MaterialsView.matches(Material(entry: $0, ctx: $0.folder), filter: store.filter, query: "") }
        if !files.isEmpty {
            if !course.modules.isEmpty {
                Section {
                    ForEach(files.indexed) { row in
                        MaterialRow(material: Material(entry: row.value, ctx: row.value.folder), courseId: course.id)
                    }
                } header: {
                    Text("Files").compactHeading()
                }
            } else {
                let byFolder = Dictionary(grouping: files) { $0.folder?.isEmpty == false ? $0.folder! : "Files" }
                ForEach(byFolder.keys.sorted(), id: \.self) { folder in
                    Section {
                        ForEach(byFolder[folder]!.indexed) { row in
                            MaterialRow(material: Material(entry: row.value, ctx: folder), courseId: course.id)
                        }
                    } header: {
                        Label(folder, systemImage: "folder").compactHeading()
                    }
                }
            }
        }
    }
}
