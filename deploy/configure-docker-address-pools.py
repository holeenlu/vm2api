#!/usr/bin/env python3
"""Add the tapmodels Docker address pool without discarding daemon settings."""

from __future__ import annotations

import argparse
import datetime as dt
import ipaddress
import json
import os
import shutil
import tempfile
from pathlib import Path


DEFAULT_CONFIG = "/etc/docker/daemon.json"
DEFAULT_BASE = "10.200.0.0/16"
DEFAULT_SIZE = 24


def parse_pool(base: str, size: int) -> tuple[str, int, ipaddress._BaseNetwork]:
    network = ipaddress.ip_network(base, strict=True)
    if not 0 <= size <= network.max_prefixlen or size < network.prefixlen:
        raise ValueError(f"pool size /{size} must be between /{network.prefixlen} and /{network.max_prefixlen}")
    return str(network), size, network


def read_config(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON in {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"Docker daemon config must be a JSON object: {path}")
    return value


def configure(path: Path, base: str, size: int) -> tuple[bool, Path | None]:
    normalized_base, normalized_size, target = parse_pool(base, size)
    config = read_config(path)
    pools = config.get("default-address-pools", [])
    if pools is None:
        pools = []
    if not isinstance(pools, list):
        raise ValueError("default-address-pools must be a JSON array")

    normalized: list[dict] = []
    for raw in pools:
        if not isinstance(raw, dict) or "base" not in raw or "size" not in raw:
            raise ValueError("each default-address-pools entry must contain base and size")
        try:
            existing = ipaddress.ip_network(str(raw["base"]), strict=True)
            existing_size = int(raw["size"])
        except (ValueError, TypeError) as exc:
            raise ValueError(f"invalid default-address-pools entry: {raw!r}") from exc
        if not 0 <= existing_size <= existing.max_prefixlen or existing_size < existing.prefixlen:
            raise ValueError(f"invalid pool size /{existing_size} for {existing}")
        if existing == target and existing_size == normalized_size:
            return False, None
        if existing.overlaps(target):
            raise ValueError(f"address pool {target} overlaps existing pool {existing}")
        normalized.append(raw)

    config["default-address-pools"] = [*normalized, {"base": normalized_base, "size": normalized_size}]
    path.parent.mkdir(parents=True, exist_ok=True)
    backup = None
    if path.exists():
        stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        backup = path.with_name(f"{path.name}.bak-{stamp}")
        shutil.copy2(path, backup)
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o644
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(config, stream, indent=2, ensure_ascii=False)
            stream.write("\n")
        os.chmod(temp_name, mode)
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)
    return True, backup


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=DEFAULT_CONFIG)
    parser.add_argument("--base", default=DEFAULT_BASE)
    parser.add_argument("--size", type=int, default=DEFAULT_SIZE)
    args = parser.parse_args()
    try:
        changed, backup = configure(Path(args.config), args.base, args.size)
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
    if changed:
        print(f"changed\t{backup or ''}")
    else:
        print("unchanged")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
