# -*- coding: utf-8 -*-
"""Gate 3-B：.truth-state 强化存储（原子写 / 权限受限 / 强绑定 / fail-closed）。

裁决要求：
- 原子写入（tmp + os.replace）；
- 权限受限（尽力 chmod；Windows 上受限权限以 ACL 语义说明）；
- 绑定具体 Adapter、Binding、revision 和 conformance evidence（强绑定 digest）；
- 缺失或损坏时 fail-closed（抛错，不得静默继续）；
- 不得成为可自行写入 ENFORCED 的单一真值来源：
  本存储只保存"conformance 证据快照"，最终能力档位由 ConformanceVerifier
  综合（binding 状态 + receipt + 证据新鲜度 + 本快照）生成；
  Adapter 的 CapabilityReporter 仅声明，不参与最终档位生成。
"""

import hashlib
import json
import os


class TruthStateError(Exception):
    def __init__(self, reason, detail=""):
        super(TruthStateError, self).__init__("%s: %s" % (reason, detail))
        self.reason = reason
        self.detail = detail


def _digest(payload):
    raw = hashlib.sha256()
    raw.update(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode())
    return raw.hexdigest()


class TruthStateStore(object):

    STATE_SCHEMA = 1

    def __init__(self, state_dir):
        self.state_dir = state_dir

    def _path(self, binding_id):
        import re
        safe = re.sub(r"[^A-Za-z0-9._-]", "_", binding_id)
        return os.path.join(self.state_dir, "%s.json" % safe)

    # ---- 原子写 ----
    def write(self, binding_id, adapter, revision, evidence_digest,
              capability_claim, evidence_meta=None):
        """写入强绑定快照（原子）。capability_claim 仅是声明，不决定档位。"""
        os.makedirs(self.state_dir, exist_ok=True)
        payload = {
            "schema_version": self.STATE_SCHEMA,
            "binding_id": binding_id,
            "adapter": adapter,
            "revision": revision,
            "evidence_digest": evidence_digest,
            "capability_claim": capability_claim,   # 声明（不决定档位）
            "evidence_meta": evidence_meta or {},
        }
        payload["state_digest"] = _digest({k: v for k, v in payload.items()
                                           if k != "state_digest"})
        path = self._path(binding_id)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=1)
            f.flush()
        os.replace(tmp, path)  # 原子
        self._restrict_permissions(path)
        return payload

    @staticmethod
    def _restrict_permissions(path):
        """尽力权限受限（POSIX 0600；Windows 依赖用户目录 ACL，记录说明）。"""
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass  # Windows：目录级 ACL 由用户环境保证

    # ---- 读（fail-closed） ----
    def read(self, binding_id):
        """读取并校验。缺失/损坏/绑定字段缺失 → 抛 TruthStateError（fail-closed）。"""
        path = self._path(binding_id)
        if not os.path.isfile(path):
            raise TruthStateError("STATE_MISSING", "binding 无 truth-state: %s"
                                  % binding_id)
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (ValueError, OSError) as e:
            raise TruthStateError("STATE_CORRUPT", "truth-state 损坏: %s" % e)
        if data.get("schema_version") != self.STATE_SCHEMA:
            raise TruthStateError("STATE_CORRUPT", "schema 不匹配")
        for field in ("binding_id", "adapter", "revision", "evidence_digest",
                      "state_digest"):
            if field not in data:
                raise TruthStateError("STATE_CORRUPT", "缺字段 %s" % field)
        # digest 复核（被替换/篡改检测）
        expect = data["state_digest"]
        actual = _digest({k: v for k, v in data.items() if k != "state_digest"})
        if actual != expect:
            raise TruthStateError("STATE_TAMPERED", "state_digest 不匹配")
        return data

    # ---- 强绑定校验 ----
    def verify_binding(self, binding_id, adapter, revision, evidence_digest):
        """绑定一致性：adapter / revision / evidence digest 全部匹配，否则 fail-closed。"""
        data = self.read(binding_id)  # 缺失/损坏/篡改 → 抛
        if data["binding_id"] != binding_id:
            raise TruthStateError("STATE_MISMATCH", "binding_id 不符")
        if data["adapter"] != adapter:
            raise TruthStateError("STATE_MISMATCH",
                                  "adapter 不符: %s != %s"
                                  % (data["adapter"], adapter))
        if data["revision"] != revision:
            raise TruthStateError("STATE_MISMATCH",
                                  "revision 不符: %s != %s"
                                  % (data["revision"], revision))
        if data["evidence_digest"] != evidence_digest:
            raise TruthStateError("STATE_MISMATCH", "evidence digest 不符")
        return data
