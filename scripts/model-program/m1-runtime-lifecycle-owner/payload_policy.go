package main

// Private attestation values, never a CLI/Profile override. Production admission
// insists on the reviewed constants and layout. An admitted context snapshots
// these values; all later operations reject mutations. Small payloads exist only
// in test binaries, whose constructors are in *_test.go and issue no authority.
type payloadPolicy struct {
	modelBytes, assetBytes, serverBytes int64
	modelSHA, assetSHA, serverSHA       string
}

func reviewedPayload() payloadPolicy {
	return payloadPolicy{modelBytes: modelBytes, assetBytes: runtimeAssetBytes, serverBytes: serverBytes, modelSHA: modelSHA, assetSHA: runtimeAssetSHA, serverSHA: serverSHA}
}
