# Frozen workflow test world

Extracted from Git 69e30b6bf1633e4637865b8c7f1ae0ff6cd746b8. This is an offline historical fixture, not an accepted current Source or an execution grant.

profiles.disk3.json keeps every YAML line in plaintext. profile-member-order.json contains only public JSON key-order metadata; the loader decodes /3, restores that order, and reconstructs the exact historical /2 bytes. The fixed historical profile SHA256 remains cdaf731653781ae1abc74bf944bdaab45bfb1bdedb4dda94f19b25f2eaca7210; roles remain 7cddf4abf791bf0f1d7feb8fb1462888f3da462033159d59694136aba16e4fa1. All four payloads have fixed byte counts and hashes in fixture.mjs. workflow-tree.txt is the same commit's complete .github/workflows Git tree listing. Tests need no .git, network, scanner, or fixture regeneration.
