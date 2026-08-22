# -*- coding: utf-8 -*-
"""Transactional cloud memory-write lifecycle for Clued R5 Gate K3.

The caller supplies an authenticated service connection.  K5 owns JWT and
real-Binding authorization; this module still requires the database Binding to
be active and to carry ``memory:write``.  All mutations cross one SECURITY
DEFINER function, use a stable client operation id, and return explicit
conflicts instead of applying last-write-wins.
"""

import hashlib
import json
import re
import uuid


_ERROR_CODE = re.compile(r"CLD-K3-[A-Z0-9-]+")
_OPERATIONS = ("CREATE", "UPDATE", "SUPERSEDE", "DELETE")


class LifecycleError(RuntimeError):
    """A content-free K3 lifecycle failure."""

    def __init__(self, code, message=None):
        self.code = code
        super().__init__(message or code)


def canonical_request_hash(payload):
    """Return the deterministic SHA-256 used by the idempotency ledger."""
    encoded = json.dumps(
        payload, ensure_ascii=False, sort_keys=True,
        separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _stable_uuid(operation_id, label):
    try:
        namespace = uuid.UUID(str(operation_id))
    except (ValueError, TypeError, AttributeError):
        raise LifecycleError("CLD-K3-OPERATION-ID-INVALID")
    return str(uuid.uuid5(namespace, label))


def _required(value, code):
    if value is None or value == "":
        raise LifecycleError(code)
    return value


class CloudMemoryLifecycle(object):
    """DB-API 2.0 facade over the K3 lifecycle stored procedures."""

    _MUTATE_SQL = """
      SELECT * FROM clued.apply_memory_mutation(
        %s::uuid, %s::uuid, %s::text, %s::text, %s::uuid, %s::text,
        %s::uuid, %s::uuid, %s::uuid, %s::uuid, %s::uuid, %s::uuid,
        %s::text, %s::text, %s::text, %s::jsonb, %s::text, %s::text,
        %s::text, %s::text, %s::numeric, %s::timestamptz,
        %s::timestamptz, %s::text)
    """
    _RESOLVE_SQL = """
      SELECT * FROM clued.resolve_memory_conflict(
        %s::uuid, %s::uuid, %s::text, %s::uuid, %s::text,
        %s::uuid, %s::uuid, %s::uuid, %s::uuid, %s::uuid)
    """

    def __init__(self, connection):
        if connection is None:
            raise LifecycleError("CLD-K3-CONNECTION-REQUIRED")
        self.connection = connection

    def _call(self, statement, params):
        cursor = None
        try:
            cursor = self.connection.cursor()
            cursor.execute(statement, params)
            row = cursor.fetchone()
            columns = [item[0] for item in cursor.description]
            self.connection.commit()
            return dict(zip(columns, row))
        except Exception as exc:
            try:
                self.connection.rollback()
            except Exception:
                pass
            match = _ERROR_CODE.search(str(exc))
            raise LifecycleError(match.group(0) if match else
                                 "CLD-K3-DATABASE-ERROR")
        finally:
            if cursor is not None:
                cursor.close()

    def mutate(self, *, account_id, binding_id, operation,
               idempotency_key, client_operation_id, memory_id=None,
               base_version_id=None, content=None, space_id=None,
               memory_type=None, scope=None, scope_refs=None,
               truth_state=None, sensitivity="NORMAL",
               source_type="CLD_K3", source_ref=None, confidence=None,
               valid_from=None, valid_until=None, reason_code=None):
        operation = str(operation or "").upper()
        if operation not in _OPERATIONS:
            raise LifecycleError("CLD-K3-OPERATION-INVALID")
        _required(account_id, "CLD-K3-ACCOUNT-REQUIRED")
        _required(binding_id, "CLD-K3-BINDING-REQUIRED")
        _required(idempotency_key, "CLD-K3-IDEMPOTENCY-KEY-INVALID")
        _required(client_operation_id, "CLD-K3-OPERATION-ID-INVALID")
        if memory_id is None:
            if operation != "CREATE":
                raise LifecycleError("CLD-K3-MEMORY-ID-REQUIRED")
            memory_id = _stable_uuid(client_operation_id, "memory")

        payload = {
            "account_id": str(account_id),
            "binding_id": str(binding_id),
            "operation": operation,
            "client_operation_id": str(client_operation_id),
            "memory_id": str(memory_id),
            "base_version_id": (str(base_version_id)
                                if base_version_id else None),
            "content": content,
            "space_id": str(space_id) if space_id else None,
            "memory_type": memory_type,
            "scope": scope,
            "scope_refs": scope_refs or {},
            "truth_state": truth_state,
            "sensitivity": sensitivity,
            "source_type": source_type,
            "source_ref": source_ref,
            "confidence": confidence,
            "valid_from": valid_from,
            "valid_until": valid_until,
            "reason_code": reason_code,
        }
        request_hash = canonical_request_hash(payload)
        params = (
            str(account_id), str(binding_id), operation, idempotency_key,
            str(client_operation_id), request_hash, str(memory_id),
            str(base_version_id) if base_version_id else None,
            _stable_uuid(client_operation_id, "version"),
            _stable_uuid(client_operation_id, "event"),
            _stable_uuid(client_operation_id, "conflict"),
            str(space_id) if space_id else None, content, memory_type, scope,
            json.dumps(scope_refs or {}, ensure_ascii=False, sort_keys=True),
            truth_state, sensitivity, source_type, source_ref, confidence,
            valid_from, valid_until, reason_code,
        )
        return self._call(self._MUTATE_SQL, params)

    def create(self, **kwargs):
        kwargs["operation"] = "CREATE"
        return self.mutate(**kwargs)

    def update(self, **kwargs):
        kwargs["operation"] = "UPDATE"
        return self.mutate(**kwargs)

    def supersede(self, **kwargs):
        kwargs["operation"] = "SUPERSEDE"
        return self.mutate(**kwargs)

    def delete(self, **kwargs):
        kwargs["operation"] = "DELETE"
        return self.mutate(**kwargs)

    def resolve(self, *, account_id, binding_id, idempotency_key,
                client_operation_id, memory_id, conflict_group_id,
                winner_version_id):
        payload = {
            "account_id": str(account_id),
            "binding_id": str(binding_id),
            "operation": "RESOLVE",
            "client_operation_id": str(client_operation_id),
            "memory_id": str(memory_id),
            "conflict_group_id": str(conflict_group_id),
            "winner_version_id": str(winner_version_id),
        }
        params = (
            str(account_id), str(binding_id), idempotency_key,
            str(client_operation_id), canonical_request_hash(payload),
            str(memory_id), str(conflict_group_id), str(winner_version_id),
            _stable_uuid(client_operation_id, "resolution-version"),
            _stable_uuid(client_operation_id, "event"),
        )
        return self._call(self._RESOLVE_SQL, params)
