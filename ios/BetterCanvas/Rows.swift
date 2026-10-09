// Rows for readings and files, used on both tabs.

import SwiftUI

/// A reading's due date and the buttons to change it. Everyone in the course sees the same date.
/// Hiding a reading only matters on "Due soon", so only controls there (`canHide`) offer Hide and Unhide.
struct ReadingDateControl: View {
    let courseId: Int
    let url: String
    var canHide = false
    @Environment(AppStore.self) private var store

    var body: some View {
        let key = store.readingKey(courseId, url)
        let deadline = store.deadline(courseId, url)
        let discussed = store.discussed(courseId, url)
        VStack(alignment: .leading, spacing: 4) {
            if let discussed, canHide {
                HStack {
                    HStack(spacing: 5) {
                        Image(systemName: "eye.slash").imageScale(.small)
                        Text("Hidden · \(discussed.by)")
                    }
                    .foregroundStyle(.secondary)
                    Button("Unhide") { store.changeReading(courseId: courseId, url: url, .hide(false)) }
                        .buttonStyle(.borderless)
                }
            } else if let deadline {
                let past = deadline.date < Dates.dayFromToday(0)
                Menu {
                    dayButtons(current: deadline.date)
                    Divider()
                    Button("Remove date", role: .destructive) { store.changeReading(courseId: courseId, url: url, .removeDate) }
                    if canHide { hideButton }
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "calendar").imageScale(.small)
                        Text("\(past ? "Was due" : "Due") \(Dates.shortDay(deadline.date))")
                    }
                    .foregroundStyle(past ? Color.secondary : Color.accentColor)
                }
                Text("Added by \(deadline.by)").font(.caption2).foregroundStyle(.tertiary)
            } else {
                Menu {
                    dayButtons(current: nil)
                    if canHide {
                        Divider()
                        hideButton
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "plus").imageScale(.small)
                        Text("Due date")
                    }
                }
            }
            if let error = store.readingErrors[key] {
                Text(error).font(.caption).foregroundStyle(.red)
            }
        }
        .font(.footnote)
        .disabled(store.savingReadings.contains(key))
    }

    private var hideButton: some View {
        Button("Hide", systemImage: "eye.slash") { store.changeReading(courseId: courseId, url: url, .hide(true)) }
    }

    /// "Today · Fri, Oct 9", "Tomorrow · Sat, Oct 10", then just "Mon, Oct 12".
    private func dayLabel(_ day: String) -> String {
        day == Dates.dayFromToday(0) || day == Dates.dayFromToday(1)
            ? "\(Dates.dayButtonLabel(day)) · \(Dates.shortDay(day))" : Dates.shortDay(day)
    }

    @ViewBuilder
    private func dayButtons(current: String?) -> some View {
        ForEach(Dates.pickableDays(), id: \.self) { day in
            Button {
                store.changeReading(courseId: courseId, url: url, .setDate(day))
            } label: {
                if day == current {
                    Label(dayLabel(day), systemImage: "checkmark")
                } else {
                    Text(dayLabel(day))
                }
            }
        }
    }
}

/// A file, page or link. Tapping opens its preview when there is one, otherwise the original link.
struct MaterialRow: View {
    let material: Material
    let courseId: Int
    var showDate = true
    var showContext = false
    @Environment(AppStore.self) private var store
    @Environment(\.openURL) private var openURL
    @State private var preview: PreviewTarget?

    var body: some View {
        let entry = material.entry
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: entry.category.symbol)
                .frame(width: 22).foregroundStyle(.secondary).padding(.top, 2)
            VStack(alignment: .leading, spacing: 4) {
                Button(action: open) {
                    Text(entry.title).foregroundStyle(entry.canPreview ? Color.primary : Color.accentColor)
                }
                .buttonStyle(.plain)
                if showContext, let ctx = material.ctx, !ctx.isEmpty {
                    Text(ctx).font(.caption).foregroundStyle(.secondary)
                }
                if showDate, entry.category == .reading, let url = entry.url {
                    ReadingDateControl(courseId: courseId, url: url, canHide: false)
                }
            }
            Spacer(minLength: 0)
            if let link = downloadLink { DownloadLink(url: link) }
        }
        .sheet(item: $preview) { PreviewSheet(target: $0) }
    }

    private func open() {
        if material.entry.canPreview {
            preview = PreviewTarget(entry: material.entry, courseId: courseId)
        } else if let url = material.entry.url.flatMap(URL.init(string:)) {
            openURL(url)
        }
    }

    /// A direct download link for a file. CourseWorks lists carry one for loose files; otherwise it's built from the file number.
    private var downloadLink: URL? {
        let entry = material.entry
        if let download = entry.download { return URL(string: download) }
        if let id = entry.fileId, let course = store.snapshot.mats[courseId]?.url {
            return URL(string: "\(course)/files/\(id)/download?download_frd=1")
        }
        if let url = entry.url, url.range(of: #"/files/\d+$"#, options: .regularExpression) != nil {
            return URL(string: url + "/download?download_frd=1")
        }
        return nil
    }
}

/// A file attached to an assignment.
struct AttachedFileRow: View {
    let file: AttachedFile
    @Environment(\.openURL) private var openURL
    @State private var preview: PreviewTarget?

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "paperclip").frame(width: 22).foregroundStyle(.secondary)
            Button(file.name) {
                if let target = PreviewTarget(file: file) { preview = target }
                else if let url = file.url.flatMap(URL.init(string:)) { openURL(url) }
            }
            .buttonStyle(.plain)
            .foregroundStyle(file.preview == nil ? Color.accentColor : Color.primary)
            Spacer(minLength: 0)
            if let link = (file.download ?? file.url).flatMap(URL.init(string:)) { DownloadLink(url: link) }
        }
        .sheet(item: $preview) { PreviewSheet(target: $0) }
    }
}
