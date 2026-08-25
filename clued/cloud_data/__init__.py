# -*- coding: utf-8 -*-
"""Clued R5 cloud data foundation and K3 lifecycle API.

This package is intentionally not wired into the K1 Controller.  K2 builds and
qualifies the candidate PostgreSQL foundation without switching a real Binding
or changing the current Git-backed production path.
"""

MIGRATION_ID = "0001_cloud_data_foundation"
SCHEMA_VERSION = 1
LIFECYCLE_MIGRATION_ID = "0002_memory_write_lifecycle"
LIFECYCLE_SCHEMA_VERSION = 2

from .lifecycle import CloudMemoryLifecycle, LifecycleError  # noqa: E402,F401
