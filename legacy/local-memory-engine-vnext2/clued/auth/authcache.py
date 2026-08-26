# -*- coding: utf-8 -*-
"""Authorization Cache —— LKG 非秘密证明（协议 §5.4 / §7.5）。

- 只保存最后一次成功在线授权的非秘密证明元数据；
- 禁止写入令牌、Cookie、私钥、Git 凭据或可恢复的认证响应（写入时扫描拒绝）；
- 完整性：proof_hash 由 binding/account/scopes/time/subject/node 重算比对；
  篡改 → 缓存无效 → 禁止降级（§7.4 CLD-AUTH-004）。
"""

import os

from .. import manifests
from ..errors import CluedError
from ..identifiers import age_seconds


class AuthCache(object):
    def __init__(self, paths, node_id):
        """node_id 可为 str 或可调用对象（延迟解析：安装创建 node.json 前
        LKG 也必须按最终 node_id 计算 proof）。"""
        self.paths = paths
        self._node_id_value = None if callable(node_id) else node_id
        self._node_id_fn = node_id if callable(node_id) else None

    def _node_id(self):
        if self._node_id_fn is not None:
            try:
                return self._node_id_fn() or ""
            except Exception:
                return ""
        return self._node_id_value or ""

    def store(self, binding_id, account_id, scopes, authorized_at, provider,
              provider_subject_hash):
        entry = manifests.build_auth_cache(
            binding_id, account_id, scopes, authorized_at, provider,
            provider_subject_hash, self._node_id(),
            manifests.compute_proof_hash(
                binding_id, account_id, scopes, authorized_at, provider,
                provider_subject_hash, self._node_id(),
                manifests.POLICY_VERSION))
        ok, err = manifests.validate_auth_cache(entry, binding_id,
                                                self._node_id())
        if not ok:
            raise CluedError("CLD-SEC-001", "LKG 缓存自检失败: %s" % err)
        manifests.atomic_write_json(self.paths.auth_cache(binding_id), entry)
        return entry

    def load(self, binding_id):
        """返回 (entry|None, err|None)。err 非空 = 缓存存在但完整性失败。"""
        path = self.paths.auth_cache(binding_id)
        if not os.path.isfile(path):
            return None, None
        try:
            entry = manifests.read_json(path)
        except Exception as exc:
            return None, "LKG 缓存读取失败: %s" % exc
        ok, err = manifests.validate_auth_cache(entry, binding_id,
                                                self._node_id())
        if not ok:
            return entry, err
        return entry, None

    def age(self, entry):
        return age_seconds(entry.get("authorized_at"))

    def remove(self, binding_id):
        """立即删除本地可用凭据证明（卸载流程 §12.2.7）。"""
        path = self.paths.auth_cache(binding_id)
        if os.path.isfile(path):
            os.remove(path)
