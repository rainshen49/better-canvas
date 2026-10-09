// The login screen: shown when no token is saved, after logging out, or when CourseWorks rejects the token.

import SwiftUI

struct LoginView: View {
    @Environment(AppStore.self) private var store
    @State private var token = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Image("Sail").resizable().frame(width: 52, height: 52).clipShape(RoundedRectangle(cornerRadius: 12))
                        Text("Better Canvas").font(.largeTitle.bold())
                        Text("A simpler view of Columbia CourseWorks. You'll stay logged in on this phone.")
                            .foregroundStyle(.secondary)
                    }
                    .listRowBackground(Color.clear)
                }

                if let message = store.authMessage {
                    Section { Text(message).foregroundStyle(.red) }
                }

                Section("Get an access token") {
                    Label {
                        Link("Open CourseWorks settings", destination: URL(string: "https://courseworks2.columbia.edu/profile/settings")!)
                    } icon: { Image(systemName: "1.circle") }
                    Label("Tap **+ New Access Token**, enter any name, then **Generate Token**.", systemImage: "2.circle")
                    Label("Copy the token and paste it below.", systemImage: "3.circle")
                }

                Section {
                    SecureField("Paste your access token", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.go)
                        .onSubmit { store.logIn(token: token) }
                    Button("Log in") { store.logIn(token: token) }
                        .disabled(token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .bold()
                }
            }
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}
