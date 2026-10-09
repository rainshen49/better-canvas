import SwiftUI

@main
struct BetterCanvasApp: App {
    @State private var store = AppStore()

    var body: some Scene {
        WindowGroup {
            Group {
                if store.isLoggedIn {
                    TabView {
                        DueView()
                            .tabItem { Label("Due soon", systemImage: "calendar.badge.clock") }
                        MaterialsView()
                            .tabItem { Label("Slides & readings", systemImage: "books.vertical") }
                    }
                } else {
                    LoginView()
                }
            }
            .environment(store)
        }
    }
}
