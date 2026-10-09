// Talking to the Better Canvas server (the Supabase Edge Function).
// Every request carries the person's CourseWorks token in X-Canvas-Token.

import Foundation

enum Config {
    /// The Edge Function's address without "/api": the BETTER_CANVAS_API value in .github/workflows/pages.yml.
    /// It isn't in the source: it comes from ios/Config.local.xcconfig (not committed) through the BetterCanvasAPI
    /// entry in Info.plist. Copy ios/Config.local.example.xcconfig to create that file.
    static let server = Bundle.main.object(forInfoDictionaryKey: "BetterCanvasAPI") as? String ?? ""
}

struct APIError: LocalizedError {
    let message: String
    var needToken = false
    var errorDescription: String? { message }
}

struct APIClient {
    let token: String

    private static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 120
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config)
    }()

    private func request(_ path: String, query: [String: String] = [:], method: String = "GET", body: Data? = nil) throws -> URLRequest {
        guard !Config.server.isEmpty else {
            throw APIError(message: "This build has no server address. Create ios/Config.local.xcconfig (see Config.local.example.xcconfig).")
        }
        guard var components = URLComponents(string: Config.server + path) else {
            throw APIError(message: "Couldn't build the request.")
        }
        if !query.isEmpty { components.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) } }
        guard let url = components.url else { throw APIError(message: "Couldn't build the request.") }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue(token, forHTTPHeaderField: "X-Canvas-Token")
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return req
    }

    private func failure(_ data: Data, status: Int) -> APIError {
        let f = try? JSONDecoder().decode(ServerFailure.self, from: data)
        return APIError(message: f?.error ?? "HTTP \(status)", needToken: f?.needToken ?? false)
    }

    private func send(_ req: URLRequest) async throws -> Data {
        let data: Data, response: URLResponse
        do {
            (data, response) = try await Self.session.data(for: req)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw APIError(message: "Couldn't reach the server.")
        }
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw failure(data, status: http.statusCode)
        }
        return data
    }

    func get<T: Decodable>(_ path: String, query: [String: String] = [:], as: T.Type = T.self) async throws -> T {
        let data = try await send(try request(path, query: query))
        return try JSONDecoder().decode(T.self, from: data)
    }

    func bytes(_ path: String, query: [String: String] = [:]) async throws -> Data {
        try await send(try request(path, query: query))
    }

    /// POST /api/reading-deadline. The server answers {"deadline", "discussed"} or {"error"}.
    func changeReading(courseId: Int, url: String, change: [String: Any]) async throws -> ReadingState {
        var body: [String: Any] = ["course_id": courseId, "url": url]
        body.merge(change) { $1 }
        let req = try request("/api/reading-deadline", method: "POST", body: try JSONSerialization.data(withJSONObject: body))
        let data = try await send(req)
        let state = try JSONDecoder().decode(ReadingState.self, from: data)
        if let message = state.error { throw APIError(message: message, needToken: state.needToken ?? false) }
        return state
    }

    /// GET /api/data as lines of JSON, one update per line, as each piece is ready.
    func dataLines() -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let (bytes, response) = try await Self.session.bytes(for: try request("/api/data"))
                    let http = response as? HTTPURLResponse
                    let isStream = (http?.value(forHTTPHeaderField: "Content-Type") ?? "").contains("ndjson")
                    if !isStream {
                        // Something went wrong: one error message instead of a series of updates.
                        var data = Data()
                        for try await byte in bytes { data.append(byte) }
                        throw failure(data, status: http?.statusCode ?? 0)
                    }
                    // Split on "\n" only: `bytes.lines` also breaks at U+2028, U+0085 and the like, which are
                    // allowed inside a JSON string and do turn up in assignment text.
                    var buffer = Data()
                    func flush() {
                        let line = String(decoding: buffer, as: UTF8.self)
                        buffer.removeAll(keepingCapacity: true)
                        if !line.trimmingCharacters(in: .whitespaces).isEmpty { continuation.yield(line) }
                    }
                    for try await byte in bytes {
                        if byte == 0x0A { flush() } else { buffer.append(byte) }
                    }
                    flush()
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish(throwing: CancellationError())
                } catch let error as APIError {
                    continuation.finish(throwing: error)
                } catch let error as URLError where error.code == .cancelled {
                    continuation.finish(throwing: CancellationError())
                } catch {
                    continuation.finish(throwing: APIError(message: "Couldn't reach the server."))
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
