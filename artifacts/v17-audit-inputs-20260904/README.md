# V17 frozen audit inputs

This directory distributes the four requested files as actual Git blobs. It does not issue a gate or closeout decision. The ZIP is unchanged, not repacked.

Original ZIP: Clued-Kernel-Next-V17-Local-RC-20260903.zip
Expected bytes: 848941
Expected SHA-256: 66b71187e6e467a44aa1149bf5c757efa64bfb99620d37a43e0d5bf2678bb1b4

The three verification reports are auxiliary evidence only. The recipient must independently inspect the original ZIP.

If the repository connector cannot export binary files, read the five transport/ZIP.base64.partNN.txt files in SOURCE_MANIFEST.json order. Concatenate their raw ASCII contents without additions, decode RFC4648 base64, and verify the decoded length and SHA-256 above. These files encode all original ZIP bytes; they are not summaries or status claims.

GitHub private-repository authentication is required. A browser link alone does not materialize files in another audit session.

This evidence-only branch was created from the exact V17 candidate. Main, tags, the existing Release, production and Canonical data are not changed.
