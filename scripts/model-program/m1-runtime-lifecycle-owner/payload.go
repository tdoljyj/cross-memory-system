package main

type payloadIdentity struct{ model, archive, server fileSpec }

func productionPayload() payloadIdentity {
	return payloadIdentity{fileSpec{modelBytes, modelSHA}, fileSpec{runtimeAssetBytes, runtimeAssetSHA}, fileSpec{serverBytes, serverSHA}}
}
