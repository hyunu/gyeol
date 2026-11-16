import Foundation
import GyeolBLE

/// 완료된 BLE 파일을 서버로 올리는 상태 머신.
///
/// 순서: 기기 등록 → 녹음 생성 → 청크 PUT → `/ack` → `/analyze`.
/// 각 단계의 결과를 `UploadCheckpoint` 로 저장해 앱이 재시작돼도 이어서 진행한다.
@MainActor
final class UploadController: ObservableObject {
    struct Item: Identifiable, Equatable {
        let clientRecordingId: String
        let byteSize: Int
        var phase: UploadPhase
        var uploadedBytes: Int
        var recordingId: String?
        var analysisJobId: String?
        var conversationId: String?
        var error: String?

        var id: String { clientRecordingId }

        var progress: Double {
            guard byteSize > 0 else { return 0 }
            return min(1, max(0, Double(uploadedBytes) / Double(byteSize)))
        }
    }

    @Published private(set) var items: [Item] = []
    @Published private(set) var device: DeviceInfo?
    @Published private(set) var busy = false
    @Published var error: String?

    private let api = ApiClient()
    private let store = DiskTransferStore()
    private var checkpoints: [String: UploadCheckpoint] = [:]
    private var itemErrors: [String: String] = [:]

    private static let defaultsKey = "gyeol.upload.checkpoints.v1"
    private static let maxChunkBytes = 256 * 1024
    /// 분석 작업 폴링 간격(1초)과 한 번에 기다리는 최대 횟수.
    /// 서버 워커가 기본 1초 간격이므로 10회면 약 10초까지 결과를 기다린다.
    private static let analysisPollInterval: UInt64 = 1_000_000_000
    private static let maxAnalysisPolls = 10

    init() {
        checkpoints = Self.loadCheckpoints()
    }

    /// BLE 완료 목록과 저장된 업로드 상태를 합쳐 UI 목록을 만든다.
    func refresh(files: [BleFileMeta]) {
        var sizes: [String: (byteSize: Int, sha256: String)] = [:]
        for file in files {
            sizes[file.clientRecordingId] = (file.byteSize, file.sha256)
        }
        // 로컬 목록이 잠시 비어도 진행 중이던 항목은 계속 보여 준다.
        for (id, checkpoint) in checkpoints where sizes[id] == nil {
            sizes[id] = (checkpoint.byteSize, checkpoint.sha256)
        }

        items = sizes.map { id, size in
            let checkpoint = checkpoints[id]
            return Item(
                clientRecordingId: id,
                byteSize: size.byteSize,
                phase: checkpoint?.phase ?? .ready,
                uploadedBytes: checkpoint?.uploadedBytes ?? 0,
                recordingId: checkpoint?.recordingId,
                analysisJobId: checkpoint?.analysisJobId,
                conversationId: checkpoint?.conversationId,
                error: itemErrors[id]
            )
        }
        .sorted { $0.clientRecordingId < $1.clientRecordingId }
    }

    func uploadPending(files: [BleFileMeta], hello: BleHello?, session: AuthSession) async {
        guard !busy else { return }
        guard let hello else {
            error = "기기 정보(HELLO)를 받지 못했습니다. 기기에 다시 연결해 주세요."
            return
        }
        busy = true
        error = nil
        defer { busy = false }

        do {
            device = try await ensureDevice(hello: hello, token: session.token)
        } catch {
            self.error = error.localizedDescription
            return
        }

        refresh(files: files)
        for file in files {
            // 분석 단계 이후는 다시 올리지 않는다. `.analyzing` 은 아래에서 폴링한다.
            if let checkpoint = checkpoints[file.clientRecordingId],
               [.analyzing, .analyzed, .analysisFailed, .failed].contains(checkpoint.phase) {
                continue
            }
            do {
                try await upload(file: file, token: session.token)
                itemErrors[file.clientRecordingId] = nil
            } catch {
                itemErrors[file.clientRecordingId] = error.localizedDescription
            }
            refresh(files: files)
        }

        await pollPendingAnalyses(token: session.token)
        refresh(files: files)
    }

    // ------------------------------------------------------------ analysis

    /// `/analyze` 를 등록한 파일의 작업 상태를 확인해 성공/실패를 반영한다.
    ///
    /// 아직 진행 중이면 `.analyzing` 으로 남겨 두고 다음 호출에서 이어서 확인한다.
    /// 앱을 재시작해도 `.analyzing` 체크포인트가 저장돼 있어 자동으로 재개된다.
    private func pollPendingAnalyses(token: String) async {
        let pending = checkpoints.values
            .filter { $0.phase == .analyzing }
            .sorted { $0.updatedAt < $1.updatedAt }
            .map(\.clientRecordingId)

        for id in pending {
            await pollAnalysis(id, token: token)
        }
    }

    private func pollAnalysis(_ id: String, token: String) async {
        guard var checkpoint = checkpoints[id], checkpoint.phase == .analyzing else {
            return
        }
        guard let jobId = checkpoint.analysisJobId else {
            itemErrors[id] = UploadError.analysisJobMissing.localizedDescription
            return
        }

        do {
            for attempt in 0..<Self.maxAnalysisPolls {
                let job = try await api.getAnalysisJob(id: jobId, token: token)
                switch UploadPlanner.analysisState(job.status) {
                case .succeeded:
                    checkpoint.phase = .analyzed
                    checkpoint.conversationId = job.conversationId
                    save(checkpoint)
                    itemErrors[id] = job.conversationId == nil
                        ? UploadError.missingConversation.localizedDescription
                        : nil
                    return
                case .failed:
                    checkpoint.phase = .analysisFailed
                    save(checkpoint)
                    itemErrors[id] = UploadError.analysisFailed.localizedDescription
                    return
                case .pending:
                    if attempt + 1 < Self.maxAnalysisPolls {
                        try await Task.sleep(nanoseconds: Self.analysisPollInterval)
                    }
                }
            }
            // 아직 진행 중이다. 상태를 유지해 다음 호출에서 다시 확인한다.
            itemErrors[id] = UploadError.analysisTimedOut.localizedDescription
        } catch is CancellationError {
            return
        } catch {
            itemErrors[id] = error.localizedDescription
        }
    }

    // -------------------------------------------------------------- device

    private func ensureDevice(hello: BleHello, token: String) async throws -> DeviceInfo {
        if let device, device.serialNo == hello.serialNo {
            return device
        }
        let devices = try await api.listDevices(token: token)
        if let existing = devices.first(where: { $0.serialNo == hello.serialNo }) {
            return existing
        }
        return try await api.registerDevice(
            serialNo: hello.serialNo,
            model: hello.model ?? "unknown",
            firmwareVersion: hello.firmwareVersion,
            token: token
        )
    }

    // ------------------------------------------------------------- upload

    private func upload(file: BleFileMeta, token: String) async throws {
        guard let deviceId = device?.id else { throw UploadError.missingDevice }

        var checkpoint = try prepare(file: file)
        checkpoint.deviceId = deviceId

        if checkpoint.recordingId == nil || checkpoint.sessionId == nil {
            let created = try await api.createRecording(
                deviceId: deviceId,
                clientRecordingId: checkpoint.clientRecordingId,
                startedAt: checkpoint.startedAt,
                endedAt: checkpoint.endedAt,
                durationMs: checkpoint.durationMs,
                codec: checkpoint.codec,
                sampleRateHz: checkpoint.sampleRateHz,
                channels: checkpoint.channels,
                byteSize: checkpoint.byteSize,
                sha256: checkpoint.sha256,
                token: token
            )
            checkpoint.recordingId = created.recording.id
            checkpoint.sessionId = created.uploadSession.id
            checkpoint.chunkSizeBytes = max(1, min(Self.maxChunkBytes, created.uploadSession.chunkSizeBytes))
            checkpoint.uploadedBytes = created.uploadSession.receivedBytes

            if created.recording.status == "integrity_failed" {
                checkpoint.phase = .failed
                save(checkpoint)
                throw UploadError.integrityFailed
            }
            if created.recording.status == "stored" || created.uploadSession.status == "completed" {
                checkpoint.phase = .uploaded
            } else {
                checkpoint.phase = .uploading
            }
            save(checkpoint)
        }

        switch checkpoint.phase {
        case .analyzing, .analyzed, .analysisFailed, .failed:
            save(checkpoint)
            return
        case .acked:
            try await analyze(&checkpoint, token: token)
        case .uploaded:
            try await acknowledgeAndAnalyze(&checkpoint, token: token)
        case .ready, .uploading:
            checkpoint.phase = .uploading
            try await sendChunks(&checkpoint, token: token)
            if checkpoint.phase == .uploaded {
                try await acknowledgeAndAnalyze(&checkpoint, token: token)
            }
        }
    }

    private func prepare(file: BleFileMeta) throws -> UploadCheckpoint {
        if var checkpoint = checkpoints[file.clientRecordingId] {
            // BLE 완료 메타데이터가 더 최신이다.
            checkpoint.byteSize = file.byteSize
            checkpoint.sha256 = file.sha256
            return checkpoint
        }

        let header = store.read(file.clientRecordingId, offset: 0, length: min(file.byteSize, 4096))
        guard let wav = WavMetadata.parse(header, fileSize: file.byteSize) else {
            throw UploadError.invalidWav
        }
        // 기기에는 RTC 가 없다. 수신 시작 시각에서 길이를 빼 녹음 시작을 근사한다.
        let receivedAt = store.createdAt(file.clientRecordingId) ?? Date()
        let checkpoint = UploadCheckpoint(
            clientRecordingId: file.clientRecordingId,
            startedAt: receivedAt.addingTimeInterval(-Double(wav.durationMs) / 1000.0),
            durationMs: wav.durationMs,
            codec: wav.codec,
            sampleRateHz: wav.sampleRateHz,
            channels: wav.channels,
            byteSize: file.byteSize,
            sha256: file.sha256,
            chunkSizeBytes: Self.maxChunkBytes
        )
        checkpoints[file.clientRecordingId] = checkpoint
        persist()
        return checkpoint
    }

    private func sendChunks(_ checkpoint: inout UploadCheckpoint, token: String) async throws {
        var renewals = 0

        while checkpoint.phase == .uploading {
            if checkpoint.uploadedBytes >= checkpoint.byteSize {
                checkpoint.phase = .uploaded
                save(checkpoint)
                return
            }
            guard let recordingId = checkpoint.recordingId, let sessionId = checkpoint.sessionId else {
                throw UploadError.missingRecording
            }
            guard let range = UploadPlanner.nextRange(
                offset: checkpoint.uploadedBytes,
                totalBytes: checkpoint.byteSize,
                chunkSizeBytes: checkpoint.chunkSizeBytes
            ) else {
                checkpoint.phase = .uploaded
                save(checkpoint)
                return
            }

            let chunk = store.read(
                checkpoint.clientRecordingId,
                offset: range.lowerBound,
                length: range.count
            )
            guard chunk.count == range.count else {
                throw UploadError.localFileTruncated
            }

            do {
                let progress = try await api.appendChunk(
                    recordingId: recordingId,
                    sessionId: sessionId,
                    offset: range.lowerBound,
                    chunk: chunk,
                    token: token
                )
                checkpoint.uploadedBytes = progress.uploadSession.receivedBytes
                checkpoint.chunkSizeBytes = max(1, min(Self.maxChunkBytes, progress.uploadSession.chunkSizeBytes))

                if progress.recording.status == "integrity_failed" || progress.uploadSession.status == "aborted" {
                    checkpoint.phase = .failed
                    save(checkpoint)
                    throw UploadError.integrityFailed
                }
                if progress.recording.status == "stored" || progress.uploadSession.status == "completed" {
                    checkpoint.phase = .uploaded
                }
                save(checkpoint)
            } catch let error as ApiError {
                if case let .offsetMismatch(expected) = error {
                    // 서버가 같은 오프셋을 다시 기대하면 재전송으로 진행할 수 없다.
                    if expected == range.lowerBound { throw error }
                    // 서버가 이미 받은 지점으로 되돌린다.
                    checkpoint.uploadedBytes = min(max(0, expected), checkpoint.byteSize)
                    if checkpoint.uploadedBytes >= checkpoint.byteSize {
                        let recording = try await api.getRecording(id: recordingId, token: token)
                        if recording.status == "integrity_failed" {
                            checkpoint.phase = .failed
                            save(checkpoint)
                            throw UploadError.integrityFailed
                        }
                        if recording.status == "stored" || recording.status == "analyzed" {
                            checkpoint.phase = .uploaded
                        }
                    }
                    save(checkpoint)
                    continue
                }
                if error.serverCode == "SESSION_NOT_OPEN" {
                    renewals += 1
                    if renewals > 2 { throw error }
                    let renewed = try await api.createUploadSession(recordingId: recordingId, token: token)
                    checkpoint.sessionId = renewed.uploadSession.id
                    checkpoint.uploadedBytes = renewed.uploadSession.receivedBytes
                    checkpoint.chunkSizeBytes = max(
                        1,
                        min(Self.maxChunkBytes, renewed.uploadSession.chunkSizeBytes)
                    )
                    save(checkpoint)
                    continue
                }
                throw error
            }
        }
    }

    private func acknowledgeAndAnalyze(_ checkpoint: inout UploadCheckpoint, token: String) async throws {
        guard let recordingId = checkpoint.recordingId else { throw UploadError.missingRecording }

        let recording = try await api.acknowledgeRecording(id: recordingId, token: token)
        if recording.status == "integrity_failed" {
            checkpoint.phase = .failed
            save(checkpoint)
            throw UploadError.integrityFailed
        }
        checkpoint.phase = .acked
        save(checkpoint)

        try await analyze(&checkpoint, token: token)
    }

    private func analyze(_ checkpoint: inout UploadCheckpoint, token: String) async throws {
        guard let recordingId = checkpoint.recordingId else { throw UploadError.missingRecording }
        let accepted = try await api.analyzeRecording(id: recordingId, token: token)
        checkpoint.analysisJobId = accepted.job.id
        checkpoint.phase = .analyzing
        save(checkpoint)
    }

    // ------------------------------------------------------------ storage

    private func save(_ checkpoint: UploadCheckpoint) {
        var next = checkpoint
        next.updatedAt = Date()
        checkpoints[next.clientRecordingId] = next
        persist()

        if let index = items.firstIndex(where: { $0.clientRecordingId == next.clientRecordingId }) {
            items[index].phase = next.phase
            items[index].uploadedBytes = next.uploadedBytes
            items[index].recordingId = next.recordingId
            items[index].analysisJobId = next.analysisJobId
            items[index].conversationId = next.conversationId
        }
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(checkpoints) else { return }
        UserDefaults.standard.set(data, forKey: Self.defaultsKey)
    }

    private static func loadCheckpoints() -> [String: UploadCheckpoint] {
        guard
            let data = UserDefaults.standard.data(forKey: defaultsKey),
            let checkpoints = try? JSONDecoder().decode([String: UploadCheckpoint].self, from: data)
        else {
            return [:]
        }
        return checkpoints
    }
}

enum UploadError: LocalizedError {
    case missingDevice
    case missingRecording
    case invalidWav
    case localFileTruncated
    case integrityFailed
    case analysisJobMissing
    case analysisFailed
    case analysisTimedOut
    case missingConversation

    var errorDescription: String? {
        switch self {
        case .missingDevice:
            return "서버에 등록된 기기가 없습니다."
        case .missingRecording:
            return "서버 녹음/세션 정보가 없습니다."
        case .invalidWav:
            return "WAV 헤더를 읽지 못해 업로드 메타데이터를 만들 수 없습니다."
        case .localFileTruncated:
            return "로컬 파일이 예상보다 짧습니다."
        case .integrityFailed:
            return "서버 무결성 검증에 실패했습니다. 원본을 다시 받아야 합니다."
        case .analysisJobMissing:
            return "분석 작업 ID가 없습니다. 다시 분석을 요청해야 합니다."
        case .analysisFailed:
            return "서버 분석이 실패했습니다. 서버 로그를 확인해 주세요."
        case .analysisTimedOut:
            return "분석이 아직 진행 중입니다. 잠시 후 다시 확인해 주세요."
        case .missingConversation:
            return "분석은 끝났지만 대화 ID를 받지 못했습니다."
        }
    }
}
