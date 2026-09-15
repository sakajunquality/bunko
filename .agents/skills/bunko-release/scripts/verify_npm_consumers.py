#!/usr/bin/env python3
"""Verify already-published bunko bytes and isolated npm/Bun consumers; never publish."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile


def version(value):
    if not re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?", value):
        raise argparse.ArgumentTypeError("Use a version without the v prefix")
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True, type=version)
    parser.add_argument("--previous", required=True, type=version)
    parser.add_argument("--cli-sha256", required=True)
    parser.add_argument("--integrity", required=True, help="SHA512 integrity from successful publishing candidate")
    parser.add_argument("--dist-tag", choices=["latest", "next"], required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{64}", args.cli_sha256):
        parser.error("Invalid CLI SHA256")
    try:
        algorithm, encoded = args.integrity.split("-", 1)
        if algorithm != "sha512" or len(base64.b64decode(encoded, validate=True)) != 64:
            raise ValueError()
    except (ValueError, TypeError):
        parser.error("Invalid npm SHA512 integrity")
    if args.version == args.previous:
        parser.error("Previous and new versions must differ")
    if "-" in args.version and args.dist_tag == "latest":
        parser.error("This helper does not accept prereleases on latest")

    root = Path(tempfile.mkdtemp(prefix="bunko-release-npm-"))
    env = dict(os.environ)
    for key in list(env):
        if key.lower().startswith("npm_config_"):
            env.pop(key)
    for name in ["npmrc-user", "npmrc-global"]:
        (root / name).write_text("")
    env.update(NPM_CONFIG_USERCONFIG=str(root / "npmrc-user"),
               NPM_CONFIG_GLOBALCONFIG=str(root / "npmrc-global"),
               NPM_CONFIG_CACHE=str(root / "npm-cache"),
               NPM_CONFIG_REGISTRY="https://registry.npmjs.org/",
               BUN_INSTALL_CACHE_DIR=str(root / "bun-cache"))

    def run(command, cwd=root):
        result = subprocess.run(command, cwd=cwd, env=env, text=True,
                                capture_output=True, timeout=300)
        if result.returncode:
            raise RuntimeError(f"{command[0]} failed (exit {result.returncode}); no publication was attempted")
        return result.stdout.strip()

    package = "@sakajunquality/bunko"
    packed = json.loads(run(["npm", "pack", f"{package}@{args.version}", "--ignore-scripts", "--json"]))
    if len(packed) != 1 or packed[0]["filename"] != f"sakajunquality-bunko-{args.version}.tgz":
        raise RuntimeError("Unexpected npm pack result")
    archive = root / packed[0]["filename"]
    integrity = "sha512-" + base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode()
    if integrity != args.integrity:
        raise RuntimeError("Registry tarball differs from the publishing candidate")
    expected = {"package/" + name for name in ["LICENSE", "PROVENANCE.jsonl", "README.md",
                "SHA256SUMS", "THIRD_PARTY_NOTICES.md", "bunko.js", "package.json"]}
    with tarfile.open(archive) as tar:
        members = tar.getmembers()
        if len(members) != len(expected) or {m.name for m in members} != expected or not all(m.isfile() for m in members):
            raise RuntimeError("Unexpected npm package members; inspect current packaging before adapting the helper")
        cli_hash = hashlib.sha256(tar.extractfile("package/bunko.js").read()).hexdigest()
        metadata = json.load(tar.extractfile("package/package.json"))
    if cli_hash != args.cli_sha256 or metadata.get("version") != args.version or metadata.get("name") != package:
        raise RuntimeError("Published CLI or package identity mismatch")
    if metadata.get("scripts") or metadata.get("dependencies"):
        raise RuntimeError("Unexpected lifecycle scripts or runtime dependencies")

    consumer = root / "npm"
    consumer.mkdir()
    (consumer / "package.json").write_text(json.dumps({"name": "bunko-release-consumer", "version": "1.0.0", "private": True}))
    sequence = [args.previous, args.version, args.previous, args.version]
    for selected in sequence:
        run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", f"{package}@{selected}"], consumer)
        if run([str(consumer / "node_modules/.bin/bunko"), "version"], consumer) != selected:
            raise RuntimeError("Upgrade/rollback version mismatch")
    audit = run(["npm", "audit", "signatures"], consumer)
    if "1 package has a verified registry signature" not in audit or "1 package has a verified attestation" not in audit:
        raise RuntimeError("Registry signature and npm attestation were not both verified")
    bun_consumer = root / "bun"
    bun_consumer.mkdir()
    (bun_consumer / "package.json").write_text('{"private":true}')
    run(["bun", "add", "--ignore-scripts", f"{package}@{args.version}"], bun_consumer)
    if run([str(bun_consumer / "node_modules/.bin/bunko"), "version"], bun_consumer) != args.version:
        raise RuntimeError("Bun install version mismatch")
    for selector in [args.version, args.dist_tag]:
        if run(["bun", "x", f"{package}@{selector}", "version"]) != args.version:
            raise RuntimeError("bunx/dist-tag version mismatch")
    report = dict(status="passed", version=args.version, integrity=integrity, cliSha256=cli_hash,
                  members=sorted(expected), upgradeRollback=sequence, audit=audit,
                  bunx=[args.version, args.dist_tag], bunInstall=args.version)
    destination = root / "verification.json"
    destination.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"status": "passed", "report": str(destination)}))


if __name__ == "__main__":
    main()
