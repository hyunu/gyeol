import AuthenticationServices
import SwiftUI

@main
struct GyeolApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

struct ContentView: View {
    @StateObject private var auth = AuthController()
    @StateObject private var ble = BleCentral()

    var body: some View {
        Group {
            if let session = auth.session {
                MainView(auth: auth, ble: ble, session: session)
            } else {
                LoginView(auth: auth)
            }
        }
        .tint(GyeolTheme.accent)
    }
}

// ------------------------------------------------------------------ login

struct LoginView: View {
    @ObservedObject var auth: AuthController

    var body: some View {
        ZStack {
            GyeolTheme.base.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 24) {
                Spacer()
                Text("결")
                    .font(.system(size: 64, weight: .semibold, design: .serif))
                    .foregroundStyle(GyeolTheme.ink)
                Text("목소리로 남긴 하루의 기록")
                    .font(.callout)
                    .foregroundStyle(GyeolTheme.ink3)
                Spacer()

                if auth.busy {
                    ProgressView()
                        .frame(maxWidth: .infinity, minHeight: 48)
                } else {
                    SignInWithAppleButton(.signIn) { request in
                        request.requestedScopes = [.fullName, .email]
                        request.nonce = auth.prepareNonce()
                    } onCompletion: { result in
                        Task { await auth.complete(result) }
                    }
                    .signInWithAppleButtonStyle(.black)
                    .frame(height: 48)
                }

                if let error = auth.error {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(GyeolTheme.accent)
                }

                Text("로그인 후 서버 세션이 발급됩니다. 토큰은 Keychain 에만 저장합니다.")
                    .font(.caption)
                    .foregroundStyle(GyeolTheme.ink3)
            }
            .padding(28)
        }
    }
}

// ------------------------------------------------------------------ main

struct MainView: View {
    @ObservedObject var auth: AuthController
    @ObservedObject var ble: BleCentral
    let session: AuthSession

    var body: some View {
        TabView {
            ConversationsView(session: session)
                .tabItem { Label("기록", systemImage: "book") }
            DeviceView(ble: ble)
                .tabItem { Label("기기", systemImage: "dot.radiowaves.left.and.right") }
            SettingsView()
                .tabItem { Label("설정", systemImage: "gearshape") }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            HStack {
                Text("결")
                    .font(.system(size: 22, weight: .semibold, design: .serif))
                    .foregroundStyle(GyeolTheme.ink)
                Spacer()
                Text(session.user.displayName)
                    .font(.caption)
                    .foregroundStyle(GyeolTheme.ink3)
                Button("로그아웃") { auth.signOut() }
                    .font(.caption)
                    .foregroundStyle(GyeolTheme.accent)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 10)
            .background(GyeolTheme.base)
            .overlay(alignment: .bottom) { Rectangle().fill(GyeolTheme.line).frame(height: 1) }
        }
    }
}

struct ConversationsView: View {
    let session: AuthSession
    @State private var items: [ConversationSummary] = []
    @State private var loading = true
    @State private var error: String?

    private let api = ApiClient()

    var body: some View {
        NavigationStack {
            Group {
                if loading {
                    ProgressView("기록을 불러오는 중…")
                } else if let error {
                    VStack(spacing: 12) {
                        Text("기록을 불러오지 못했습니다.")
                            .font(.headline)
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(GyeolTheme.ink3)
                        Button("다시 시도") { Task { await load() } }
                    }
                    .padding()
                } else if items.isEmpty {
                    VStack(spacing: 8) {
                        Text("아직 기록이 없습니다.")
                            .font(.headline)
                        Text("기기에서 녹음이 올라오면 날짜별로 쌓입니다.")
                            .font(.footnote)
                            .foregroundStyle(GyeolTheme.ink3)
                    }
                    .padding()
                } else {
                    List(items) { item in
                        NavigationLink {
                            ConversationDetailView(id: item.id, session: session)
                        } label: {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(item.title ?? "제목 없는 기록")
                                    .font(.system(.headline, design: .serif))
                                    .foregroundStyle(GyeolTheme.ink)
                                if let summary = item.summary {
                                    Text(summary)
                                        .font(.subheadline)
                                        .foregroundStyle(GyeolTheme.ink2)
                                        .lineLimit(2)
                                }
                                HStack(spacing: 6) {
                                    Text(DateText.day(item.startedAt))
                                    Text("·")
                                    Text(DateText.time(item.startedAt))
                                    if !item.people.isEmpty {
                                        Text("·")
                                        Text(item.people.map(\.displayName).joined(separator: ", "))
                                    }
                                }
                                .font(.caption)
                                .foregroundStyle(GyeolTheme.ink3)
                            }
                            .padding(.vertical, 4)
                        }
                        .listRowBackground(GyeolTheme.base)
                    }
                    .listStyle(.plain)
                    .refreshable { await load() }
                }
            }
            .navigationTitle("대화 타임라인")
            .task { await load() }
            .background(GyeolTheme.base)
        }
    }

    private func load() async {
        loading = items.isEmpty
        defer { loading = false }
        do {
            items = try await api.listConversations(token: session.token)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct ConversationDetailView: View {
    let id: String
    let session: AuthSession
    @State private var detail: ConversationDetail?
    @State private var error: String?
    private let api = ApiClient()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if let detail {
                    Text(DateText.day(detail.startedAt) + " · " + DateText.time(detail.startedAt))
                        .font(.caption)
                        .foregroundStyle(GyeolTheme.ink3)
                    Text(detail.title ?? "제목 없는 기록")
                        .font(.system(size: 28, weight: .semibold, design: .serif))
                        .foregroundStyle(GyeolTheme.ink)
                    if let summary = detail.summary {
                        Text(summary)
                            .font(.body)
                            .foregroundStyle(GyeolTheme.ink2)
                    }
                    Divider().overlay(GyeolTheme.line)

                    ForEach(detail.segments) { segment in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(DateText.segment(segment.startMs))
                                    .foregroundStyle(GyeolTheme.ink3)
                                Text(speakerName(segment.speakerClusterId, detail.speakers))
                                    .foregroundStyle(GyeolTheme.ink3)
                            }
                            .font(.caption)
                            Text(segment.text)
                                .foregroundStyle(GyeolTheme.ink)
                        }
                    }
                } else if let error {
                    Text(error).foregroundStyle(GyeolTheme.accent)
                } else {
                    ProgressView()
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20)
        }
        .background(GyeolTheme.base)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            do {
                detail = try await api.getConversation(id: id, token: session.token)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func speakerName(_ id: String?, _ speakers: [SpeakerInfo]) -> String {
        guard let id, let speaker = speakers.first(where: { $0.id == id }) else { return "화자 미상" }
        return speaker.displayName ?? speaker.label
    }
}

struct DeviceView: View {
    @ObservedObject var ble: BleCentral

    var body: some View {
        NavigationStack {
            List {
                Section("연결") {
                    LabeledContent("Bluetooth", value: stateText)
                    if let name = ble.connectedName {
                        LabeledContent("기기", value: name)
                    }
                    HStack {
                        Button("검색") { ble.startScan() }
                        if ble.connectedName != nil {
                            Button("연결 해제", role: .destructive) { ble.disconnect() }
                        }
                    }
                }

                if !ble.devices.isEmpty {
                    Section("발견된 기기") {
                        ForEach(ble.devices) { device in
                            Button(device.name) { ble.connect(device) }
                        }
                    }
                }

                Section("전송") {
                    LabeledContent("받은 바이트", value: "\(ble.receivedBytes)")
                    if ble.completedFiles.isEmpty {
                        Text("완료된 파일이 없습니다.")
                            .foregroundStyle(GyeolTheme.ink3)
                    } else {
                        ForEach(ble.completedFiles, id: \.clientRecordingId) { file in
                            VStack(alignment: .leading) {
                                Text(file.clientRecordingId).font(.footnote)
                                Text("\(file.byteSize) bytes").font(.caption).foregroundStyle(GyeolTheme.ink3)
                            }
                        }
                    }
                }

                if let error = ble.error {
                    Section {
                        Text(error).foregroundStyle(GyeolTheme.accent)
                    }
                }
            }
            .navigationTitle("기기")
            .scrollContentBackground(.hidden)
            .background(GyeolTheme.base)
        }
    }

    private var stateText: String {
        switch ble.bluetoothState {
        case .poweredOn: return "켜짐"
        case .poweredOff: return "꺼짐"
        case .unauthorized: return "권한 없음"
        case .unsupported: return "지원 안 함"
        default: return "확인 중"
        }
    }
}


struct SettingsView: View {
    @AppStorage("apiBaseURL") private var baseURL = "http://127.0.0.1:8080"

    var body: some View {
        NavigationStack {
            Form {
                Section("서버") {
                    TextField("http://192.168.0.10:8080", text: $baseURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Text("실기기에서는 Mac의 LAN 주소를 입력하세요. 예: http://192.168.0.10:8080")
                        .font(.caption)
                        .foregroundStyle(GyeolTheme.ink3)
                }

                Section("안내") {
                    Text("현재 API: \(baseURL)")
                        .font(.caption)
                        .foregroundStyle(GyeolTheme.ink2)
                    Text("Sign in with Apple 은 App ID 와 entitlement 가 필요합니다. In-House 배포는 Distribution 인증서가 필요합니다.")
                        .font(.caption)
                        .foregroundStyle(GyeolTheme.ink3)
                }
            }
            .navigationTitle("설정")
            .scrollContentBackground(.hidden)
            .background(GyeolTheme.base)
        }
    }
}
