import AuthenticationServices
import CryptoKit
import Foundation

@MainActor
final class AuthController: ObservableObject {
    @Published private(set) var session: AuthSession?
    @Published var error: String?
    @Published var busy = false

    private let api = ApiClient()
    private var rawNonce: String?

    init() {
        session = SessionStore.load()
    }

    /// Sign in with Apple 요청에 넣을 SHA-256 nonce 를 만들고 원문을 보관한다.
    func prepareNonce() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let nonce = bytes.map { String(format: "%02x", $0) }.joined()
        rawNonce = nonce
        return SHA256.hash(data: Data(nonce.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    func complete(_ result: Result<ASAuthorization, Error>) async {
        switch result {
        case let .success(authorization):
            guard
                let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                let tokenData = credential.identityToken,
                let identityToken = String(data: tokenData, encoding: .utf8),
                let nonce = rawNonce
            else {
                error = "Apple identity token 을 받지 못했습니다."
                return
            }

            busy = true
            defer { busy = false }
            do {
                let displayName = credential.fullName.flatMap { components -> String? in
                    let formatter = PersonNameComponentsFormatter()
                    formatter.locale = Locale(identifier: "ko_KR")
                    let name = formatter.string(from: components).trimmingCharacters(in: .whitespaces)
                    return name.isEmpty ? nil : name
                }
                let session = try await api.signIn(
                    identityToken: identityToken,
                    nonce: nonce,
                    displayName: displayName
                )
                self.session = session
                SessionStore.save(session)
                error = nil
            } catch {
                self.error = error.localizedDescription
            }

        case let .failure(error):
            if (error as? ASAuthorizationError)?.code != .canceled {
                self.error = error.localizedDescription
            }
        }
    }

    /// Apple 개발자 설정 없이 UI·BLE 를 확인하기 위한 로컬 데모 세션.
    /// API 가 GYEOL_ENV=local 일 때만 동작한다(X-User-Id).
    func startLocalDemo() {
        let session = AuthSession(
            token: "",
            tokenType: "local",
            expiresAt: "2099-12-31T00:00:00Z",
            user: AuthUser(id: "0199aaaa-0000-7000-8000-000000000001", displayName: "로컬 데모")
        )
        self.session = session
        SessionStore.save(session)
        error = nil
    }

    func signOut() {
        session = nil
        SessionStore.clear()
    }
}
