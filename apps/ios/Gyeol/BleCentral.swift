import CoreBluetooth
import Foundation
import GyeolBLE

struct DiscoveredDevice: Identifiable, Equatable {
    let id: UUID
    let name: String
}

@MainActor
final class BleCentral: NSObject, ObservableObject {
    @Published private(set) var bluetoothState: CBManagerState = .unknown
    @Published private(set) var devices: [DiscoveredDevice] = []
    @Published private(set) var connectedName: String?
    @Published private(set) var receivedBytes = 0
    @Published private(set) var completedFiles: [BleFileMeta] = []
    @Published var error: String?

    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var tx: CBCharacteristic?
    private var rx: CBCharacteristic?
    private var discovered: [UUID: CBPeripheral] = [:]
    private let store = DiskTransferStore()
    private lazy var receiver = BleTransferReceiver(store: store)
    private let stream = BleFrameStream()
    private var lastAckSent = 0

    private let serviceUUID = CBUUID(string: BleProtocol.serviceUUID)
    private let txUUID = CBUUID(string: BleProtocol.txUUID)
    private let rxUUID = CBUUID(string: BleProtocol.rxUUID)

    override init() {
        super.init()
        central = CBCentralManager(delegate: self, queue: .main)
    }

    func startScan() {
        guard central.state == .poweredOn else {
            error = "Bluetooth 를 사용할 수 없습니다."
            return
        }
        devices = []
        discovered = [:]
        error = nil
        connectedName = nil
        central.scanForPeripherals(withServices: [serviceUUID], options: nil)
    }

    func stopScan() {
        central.stopScan()
    }

    func connect(_ device: DiscoveredDevice) {
        guard let target = discovered[device.id] else { return }
        central.stopScan()
        peripheral = target
        target.delegate = self
        central.connect(target, options: nil)
    }

    func disconnect() {
        if let peripheral {
            central.cancelPeripheralConnection(peripheral)
        }
        resetConnection()
    }

    private func resetConnection() {
        lastAckSent = 0
        peripheral = nil
        tx = nil
        rx = nil
        connectedName = nil
    }

    private func send(_ frames: [BleFrame]) {
        guard let peripheral, let rx else { return }
        for frame in frames {
            guard let data = try? BleProtocol.encode(frame) else { continue }
            peripheral.writeValue(data, for: rx, type: .withResponse)
        }
    }
}

extension BleCentral: CBCentralManagerDelegate {
    nonisolated func centralManagerDidUpdateState(_ central: CBCentralManager) {
        Task { @MainActor in
            bluetoothState = central.state
            if central.state == .poweredOn {
                startScan()
            }
        }
    }

    nonisolated func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        Task { @MainActor in
            let name = peripheral.name ?? advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? "이름 없음"
            discovered[peripheral.identifier] = peripheral
            if !devices.contains(where: { $0.id == peripheral.identifier }) {
                devices.append(DiscoveredDevice(id: peripheral.identifier, name: name))
            }
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        Task { @MainActor in
            connectedName = peripheral.name ?? "기기"
            peripheral.discoverServices([serviceUUID])
        }
    }

    nonisolated func centralManager(
        _ central: CBCentralManager,
        didFailToConnect peripheral: CBPeripheral,
        error: Error?
    ) {
        Task { @MainActor in
            self.error = error?.localizedDescription ?? "기기에 연결하지 못했습니다."
            resetConnection()
        }
    }
}

extension BleCentral: CBPeripheralDelegate {
    nonisolated func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        Task { @MainActor in
            if let error {
                self.error = error.localizedDescription
                return
            }
            for service in peripheral.services ?? [] where service.uuid == serviceUUID {
                peripheral.discoverCharacteristics([txUUID, rxUUID], for: service)
            }
        }
    }

    nonisolated func peripheral(
        _ peripheral: CBPeripheral,
        didDiscoverCharacteristicsFor service: CBService,
        error: Error?
    ) {
        Task { @MainActor in
            if let error {
                self.error = error.localizedDescription
                return
            }
            for characteristic in service.characteristics ?? [] {
                if characteristic.uuid == txUUID {
                    tx = characteristic
                    peripheral.setNotifyValue(true, for: characteristic)
                } else if characteristic.uuid == rxUUID {
                    rx = characteristic
                }
            }
        }
    }

    nonisolated func peripheral(
        _ peripheral: CBPeripheral,
        didUpdateValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        Task { @MainActor in
            if let error {
                self.error = error.localizedDescription
                return
            }
            guard characteristic.uuid == txUUID, let data = characteristic.value else { return }
            var outbound: [BleFrame] = []
            for frame in stream.append(data) {
                for response in receiver.handle(frame) {
                    if response.type == .ack,
                       let object = try? JSONSerialization.jsonObject(with: response.payload) as? [String: Any],
                       let bytes = object["receivedBytes"] as? Int
                    {
                        receivedBytes = max(receivedBytes, bytes)
                        // 매 프레임 ACK 하면 BLE 왕복이 병목이다. 4프레임마다 한 번만 보낸다.
                        let threshold = 4 * BleProtocol.recommendedChunkBytes
                        if !frame.isLast && bytes - lastAckSent < threshold { continue }
                        lastAckSent = bytes
                    }
                    outbound.append(response)
                }
            }
            completedFiles = store.list()
            if !outbound.isEmpty { send(outbound) }
        }
    }
}
