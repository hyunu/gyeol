import Foundation

struct AuthUser: Codable, Equatable {
    let id: String
    let displayName: String
}

struct AuthSession: Codable, Equatable {
    let token: String
    let tokenType: String
    let expiresAt: String
    let user: AuthUser
}

struct PersonRef: Codable, Identifiable, Equatable {
    let id: String
    let displayName: String
}

struct ConversationSummary: Codable, Identifiable {
    let id: String
    let title: String?
    let summary: String?
    let startedAt: String
    let endedAt: String
    let people: [PersonRef]
}

struct ConversationPage: Codable {
    let items: [ConversationSummary]
}

struct SpeakerInfo: Codable, Identifiable {
    let id: String
    let label: String
    let displayName: String?
}

struct TranscriptSegment: Codable, Identifiable {
    let id: String
    let seq: Int
    let startMs: Int
    let text: String
    let speakerClusterId: String?
}

struct ConversationDetail: Codable {
    let id: String
    let title: String?
    let summary: String?
    let startedAt: String
    let endedAt: String
    let people: [PersonRef]
    let speakers: [SpeakerInfo]
    let segments: [TranscriptSegment]
}

private struct SessionResponse: Codable {
    let session: AuthSession
}

private struct Problem: Codable {
    let title: String?
    let detail: String?
    let code: String?
}

enum ApiError: LocalizedError {
    case badURL
    case server(Int, String)
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .badURL:
            return "API 주소가 올바르지 않습니다."
        case let .server(status, message):
            return "서버 오류 \(status): \(message)"
        case let .decoding(message):
            return "응답을 해석하지 못했습니다: \(message)"
        }
    }
}

struct ApiClient {
    /// 설정 화면에서 저장한 주소 → Info.plist → localhost 순으로 사용한다.
    var baseURL: URL {
        if
            let saved = UserDefaults.standard.string(forKey: "apiBaseURL"),
            !saved.isEmpty,
            let url = URL(string: saved)
        {
            return url
        }
        if
            let value = Bundle.main.object(forInfoDictionaryKey: "API_BASE_URL") as? String,
            let url = URL(string: value)
        {
            return url
        }
        return URL(string: "http://127.0.0.1:8080")!
    }

    func signIn(identityToken: String, nonce: String, displayName: String?) async throws -> AuthSession {
        var request = URLRequest(url: baseURL.appending(path: "/api/v1/auth/apple"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        var body: [String: String] = ["identityToken": identityToken, "nonce": nonce]
        if let displayName, !displayName.isEmpty {
            body["displayName"] = displayName
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let response: SessionResponse = try await send(request)
        return response.session
    }

    func listConversations(token: String) async throws -> [ConversationSummary] {
        var request = URLRequest(url: baseURL.appending(path: "/api/v1/conversations"))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        let page: ConversationPage = try await send(request)
        return page.items
    }

    func getConversation(id: String, token: String) async throws -> ConversationDetail {
        var request = URLRequest(url: baseURL.appending(path: "/api/v1/conversations/\(id)"))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        return try await send(request)
    }

    private func send<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw ApiError.server(0, "HTTP 응답이 아닙니다.")
        }
        guard (200..<300).contains(http.statusCode) else {
            if let problem = try? JSONDecoder().decode(Problem.self, from: data) {
                throw ApiError.server(http.statusCode, problem.detail ?? problem.title ?? problem.code ?? "알 수 없음")
            }
            throw ApiError.server(http.statusCode, String(data: data, encoding: .utf8) ?? "")
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw ApiError.decoding(String(describing: error))
        }
    }
}

enum DateText {
    private static let iso = ISO8601DateFormatter()

    static func day(_ value: String) -> String {
        guard let date = iso.date(from: value) else { return value }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ko_KR")
        formatter.dateFormat = "M월 d일 E"
        return formatter.string(from: date)
    }

    static func time(_ value: String) -> String {
        guard let date = iso.date(from: value) else { return value }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ko_KR")
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: date)
    }

    static func segment(_ milliseconds: Int) -> String {
        let seconds = max(0, milliseconds / 1000)
        return String(format: "%02d:%02d", seconds / 60, seconds % 60)
    }
}
