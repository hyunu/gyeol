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
            if let checkpoint = checkpoints[file.clientRecordingId],
               checkpoint.phase == .analyzing || checkpoint.phase == .failed {
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
        refresh(files: files)
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
        case .analyzing, .failed:
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
        }
    }
}
