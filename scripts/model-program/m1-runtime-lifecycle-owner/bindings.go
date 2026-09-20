package main

// M1-08 effectful owner candidate bindings.
//
// issuerPublicKeyHex / issuerPublicKeySHA256 intentionally remain empty in the
// implementation-preparation candidate. They MUST be replaced by an Owner-
// selected Ed25519 public root in a separately reviewed successor before Final
// Issuance. Production execution fails closed while either is empty.
const issuerPublicKeyHex = ""
const issuerPublicKeySHA256 = ""

// Injected by the deterministic build script from source-manifest.json via
// -ldflags -X main.nativeSourceDigest=<sha256>. Runtime input cannot set it.
var nativeSourceDigest = ""
