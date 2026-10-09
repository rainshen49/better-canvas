// Date handling, following static/app.js: reading due dates are plain days
// ("YYYY-MM-DD") in the phone's own time zone, and a reading may be dated on one
// of the next `pickWeekdays` weekdays.

import Foundation

enum Dates {
    /// A reading's due date can be one of the next this-many weekdays, counting today if it's a weekday.
    static let pickWeekdays = 10

    private static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let plain = ISO8601DateFormatter()

    private static func formatter(_ format: String, posix: Bool = false) -> DateFormatter {
        let f = DateFormatter()
        f.locale = posix ? Locale(identifier: "en_US_POSIX") : .current
        f.dateFormat = format
        return f
    }

    // DateFormatters are expensive to make, and these are used for every row, so each is made once.
    private static let localDateTime = formatter("yyyy-MM-dd'T'HH:mm:ss", posix: true)
    private static let dayFormat = formatter("yyyy-MM-dd", posix: true)
    private static let dayHeadingFormat = formatter("EEEE, MMM d")
    private static let shortDayFormat = formatter("EEE, MMM d")
    private static let dateTimePrefixFormat = formatter("EEE, MMM d, ")
    private static let buttonFormat = formatter("EEE d")

    /// "2026-09-24T18:00:00Z" (with or without fractions) or a zoneless "2026-09-24T00:00:00" (local time).
    static func parse(_ text: String) -> Date? {
        withFraction.date(from: text) ?? plain.date(from: text) ?? localDateTime.date(from: text)
    }

    /// "YYYY-MM-DD" → the start of that day.
    static func parseDay(_ day: String) -> Date { dayFormat.date(from: day) ?? .distantFuture }

    static func dayString(_ date: Date) -> String { dayFormat.string(from: date) }

    static func dayFromToday(_ days: Int) -> String {
        dayString(Calendar.current.date(byAdding: .day, value: days, to: Date())!)
    }

    static func pickableDays() -> [String] {
        let cal = Calendar.current
        var days: [String] = []
        var offset = 0
        while days.count < pickWeekdays {
            let date = cal.date(byAdding: .day, value: offset, to: Date())!
            if !cal.isDateInWeekend(date) { days.append(dayString(date)) }
            offset += 1
        }
        return days
    }

    /// "Today", "Tomorrow" or "in N days".
    static func relativeDay(_ date: Date) -> String {
        let cal = Calendar.current
        let days = cal.dateComponents([.day], from: cal.startOfDay(for: Date()), to: cal.startOfDay(for: date)).day ?? 0
        switch days {
        case 0: return "Today"
        case 1: return "Tomorrow"
        case ..<0: return "\(-days) days ago"
        default: return "in \(days) days"
        }
    }

    static func dayHeading(_ date: Date) -> String { dayHeadingFormat.string(from: date) }
    static func time(_ date: Date) -> String { date.formatted(date: .omitted, time: .shortened) }
    static func shortDay(_ day: String) -> String { shortDayFormat.string(from: parseDay(day)) }

    static func dateTime(_ iso: String) -> String {
        guard let d = parse(iso) else { return iso }
        return dateTimePrefixFormat.string(from: d) + time(d)
    }

    /// "Today", "Tomorrow", then e.g. "Sat 26".
    static func dayButtonLabel(_ day: String) -> String {
        if day == dayFromToday(0) { return "Today" }
        if day == dayFromToday(1) { return "Tomorrow" }
        return buttonFormat.string(from: parseDay(day))
    }

    static func timeAgo(_ date: Date) -> String {
        let minutes = Int(Date().timeIntervalSince(date) / 60)
        if minutes < 1 { return "just now" }
        if minutes < 60 { return "\(minutes) min ago" }
        return "\(minutes / 60) h ago"
    }
}
