package main

// M1-08 effectful owner Owner-root-pinned successor bindings.
//
// The Owner explicitly authorized reuse of the existing M1-07 Ed25519 Owner
// Root for M1-08. Pinning this public root grants no effectful authority by
// itself: the profile remains non-issued, Final Issuance remains separate,
// and execution must fail closed until the exact signed issued profile passes
// every reviewed binding and authorization check.
const issuerPublicKeyHex = "a683b21e2d838f0773fc1251e6d0165c4b15ad2b2994cabf4290edff1c24eb03"
const issuerPublicKeySHA256 = "7d8a39adb80276686ff052b65e074a8ea9e74f7eccbc44f4340b194fec342f9c"

// Injected by the deterministic build script from source-manifest.json via
// -ldflags -X main.nativeSourceDigest=<sha256>. Runtime input cannot set it.
var nativeSourceDigest = ""
