// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "GyeolBLE",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "GyeolBLE", targets: ["GyeolBLE"])
    ],
    targets: [
        .target(name: "GyeolBLE"),
        .testTarget(name: "GyeolBLETests", dependencies: ["GyeolBLE"])
    ]
)
