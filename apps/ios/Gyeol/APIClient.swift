import Foundation
import GyeolBLE

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

struct DeviceInfo: Codable, Identifiable, Equatable {
    let id: String
    let serialNo: String
    let model: String
    let firmwareVersion: String?
    let online: Bool
}

struct DevicePage: Codable {
    let items: [DeviceInfo]
}

struct RecordingInfo: Codable, Equatable {
    let id: String
    let clientRecordingId: String
    let status: String
    let byteSize: Int
    let sha256: String
    let audioAvailable: Bool
    let deletable: Bool
}

struct UploadSessionInfo: Codable, Equatable {
    let id: String
    let recordingId: String
    let status: String
    let expectedBytes: Int
    let receivedBytes: Int
    let chunkSizeBytes: Int
    let nextOffset: Int
}

struct RecordingWithSession: Codable {
    let recording: RecordingInfo
    let uploadSession: UploadSessionInfo
}

struct UploadProgress: Codable {
    let recording: RecordingInfo
    let uploadSession: UploadSessionInfo
}

struct AnalysisJobInfo: Codable {
    let id: String
    let status: String
    let conversationId: String?
}

struct AnalysisAccepted: Codable {
    let recording: RecordingInfo
    let job: AnalysisJobInfo
}

private struct RecordingEnvelope: Codable {
    let recording: RecordingInfo
}

enum ApiError: LocalizedError {
    case badURL
    case server(Int, String, code: String?)
    /// 409 `OFFSET_MISMATCH`. `expected` 는 서버가 기대하는 다음 오프셋이다.
    case offsetMismatch(expected: Int)
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .badURL:
            return "API 주소가 올바르지 않습니다."
        case let .server(status, message, _):
            return "서버 오류 \(status): \(message)"
        case let .offsetMismatch(expected):
            return "업로드 오프셋을 \(expected) 바이트로 복구합니다."
        case let .decoding(message):
            return "응답을 해석하지 못했습니다: \(message)"
        }
    }

    var serverCode: String? {
        if case let .server(_, _, code) = self { return code }
        return nil
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
        authorize(&request, token: token)
        let page: ConversationPage = try await send(request)
        return page.items
    }

    func getConversation(id: String, token: String) async throws -> ConversationDetail {
        var request = URLRequest(url: baseURL.appending(path: "/api/v1/conversations/\(id)"))
        authorize(&request, token: token)
        return try await send(request)
    }

    // ------------------------------------------------------------- devices

    func listDevices(token: String) async throws -> [DeviceInfo] {
        var request = URLRequest(url: url("/api/v1/devices"))
        authorize(&request, token: token)
        let page: DevicePage = try await send(request)
        return page.items
    }

    func registerDevice(
        serialNo: String,
        model: String,
        firmwareVersion: String?,
        token: String
    ) async throws -> DeviceInfo {
        var body: [String: Any] = ["serialNo": serialNo, "model": model]
        if let firmwareVersion, !firmwareVersion.isEmpty {
            body["firmwareVersion"] = firmwareVersion
        }
        var request = URLRequest(url: url("/api/v1/devices"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        authorize(&request, token: token)
        return try await send(request)
    }

    // ---------------------------------------------------------- recordings

    func createRecording(
        deviceId: String,
        clientRecordingId: String,
        startedAt: Date,
        endedAt: Date,
        durationMs: Int,
        codec: String,
        sampleRateHz: Int,
        channels: Int,
        byteSize: Int,
        sha256: String,
        token: String
    ) async throws -> RecordingWithSession {
        let body: [String: Any] = [
            "deviceId": deviceId,
            "clientRecordingId": clientRecordingId,
            "startedAt": Self.iso8601.string(from: startedAt),
            "endedAt": Self.iso8601.string(from: endedAt),
            "durationMs": durationMs,
            "codec": codec,
            "sampleRateHz": sampleRateHz,
            "channels": channels,
            "byteSize": byteSize,
            "sha256": sha256,
        ]
        var request = URLRequest(url: url("/api/v1/recordings"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        authorize(&request, token: token)
        return try await send(request)
    }

    func createUploadSession(recordingId: String, token: String) async throws -> RecordingWithSession {
        var request = URLRequest(url: url("/api/v1/recordings/\(recordingId)/upload-sessions"))
        request.httpMethod = "POST"
        authorize(&request, token: token)
        return try await send(request)
    }

    func appendChunk(
        recordingId: String,
        sessionId: String,
        offset: Int,
        chunk: Data,
        token: String
    ) async throws -> UploadProgress {
        let path = "/api/v1/recordings/\(recordingId)/upload-sessions/\(sessionId)/chunks"
        var request = URLRequest(url: url(path, query: [URLQueryItem(name: "offset", value: String(offset))]))
        request.httpMethod = "PUT"
        request.setValue("application/octet-stream", forHTTPHeaderField: "content-type")
        request.httpBody = chunk
        authorize(&request, token: token)
        return try await send(request)
    }

    func getRecording(id: String, token: String) async throws -> RecordingInfo {
        var request = URLRequest(url: url("/api/v1/recordings/\(id)"))
        authorize(&request, token: token)
        let envelope: RecordingEnvelope = try await send(request)
        return envelope.recording
    }

    /// 무결성 검증이 끝난 녹음을 클라이언트가 수신했음을 알린다(M-04 조건 5).
    func acknowledgeRecording(id: String, token: String) async throws -> RecordingInfo {
        var request = URLRequest(url: url("/api/v1/recordings/\(id)/ack"))
        request.httpMethod = "POST"
        authorize(&request, token: token)
        let envelope: RecordingEnvelope = try await send(request)
        return envelope.recording
    }

    func analyzeRecording(id: String, token: String) async throws -> AnalysisAccepted {
        var request = URLRequest(url: url("/api/v1/recordings/\(id)/analyze"))
        request.httpMethod = "POST"
        authorize(&request, token: token)
        return try await send(request)
    }

    func getAnalysisJob(id: String, token: String) async throws -> AnalysisJobInfo {
        var request = URLRequest(url: url("/api/v1/analysis-jobs/\(id)"))
        authorize(&request, token: token)
        struct Envelope: Codable { let job: AnalysisJobInfo }
        let envelope: Envelope = try await send(request)
        return envelope.job
    }

    // -------------------------------------------------------------- helpers

    private static let iso8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private func url(_ path: String, query: [URLQueryItem] = []) -> URL {
        guard
            var components = URLComponents(url: baseURL.appending(path: path), resolvingAgainstBaseURL: false)
        else {
            return baseURL.appending(path: path)
        }
        if !query.isEmpty {
            components.queryItems = query
        }
        return components.url ?? baseURL.appending(path: path)
    }

    private func authorize(_ request: inout URLRequest, token: String) {
        if token.isEmpty {
            // 로컬 데모 세션: 서버가 GYEOL_ENV=local 일 때만 허용된다.
            request.setValue("0199aaaa-0000-7000-8000-000000000001", forHTTPHeaderField: "x-user-id")
        } else {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        }
    }

    private func send<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw ApiError.server(0, "HTTP 응답이 아닙니다.", code: nil)
        }
        guard (200..<300).contains(http.statusCode) else {
            if let problem = try? JSONDecoder().decode(Problem.self, from: data) {
                if
                    http.statusCode == 409,
                    problem.code == "OFFSET_MISMATCH",
                    let detail = problem.detail,
                    let expected = UploadPlanner.recoverOffset(fromProblemDetail: detail)
                {
                    throw ApiError.offsetMismatch(expected: expected)
                }
                throw ApiError.server(
                    http.statusCode,
                    problem.detail ?? problem.title ?? problem.code ?? "알 수 없음",
                    code: problem.code
                )
            }
            throw ApiError.server(
                http.statusCode,
                String(data: data, encoding: .utf8) ?? "",
                code: nil
            )
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
