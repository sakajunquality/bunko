#!/usr/bin/env python3
"""Verify a published bunko OCI index and anonymous consumers on both Linux architectures."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--digest", required=True, help="Published OCI index digest, including sha256:")
    parser.add_argument("--source-commit", required=True, help="Actual container workflow main SHA")
    parser.add_argument("--cli-sha256", required=True, help="CLI SHA256 from verified GitHub release")
    args = parser.parse_args()
    for value, pattern in [(args.version, r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?"),
                           (args.digest, r"sha256:[0-9a-f]{64}"),
                           (args.source_commit, r"[0-9a-f]{40}"),
                           (args.cli_sha256, r"[0-9a-f]{64}")]:
        if not re.fullmatch(pattern, value):
            parser.error("Invalid version, digest or commit")

    root = Path(tempfile.mkdtemp(prefix="bunko-release-container-"))

    def run(command, env=None):
        result = subprocess.run(command, env=env, text=True, capture_output=True, timeout=600)
        if result.returncode:
            log = root / "command-error.log"
            log.write_text(result.stderr)
            log.chmod(0o600)
            raise RuntimeError(f"{command[0]} failed (exit {result.returncode}); private diagnostics: {log}")
        return result.stdout.strip()

    image = "ghcr.io/sakajunquality/bunko@" + args.digest
    run(["gh", "attestation", "verify", "oci://" + image, "--repo", "sakajunquality/bunko",
         "--signer-workflow", "sakajunquality/bunko/.github/workflows/container.yml",
         "--source-ref", "refs/heads/main", "--source-digest", args.source_commit,
         "--deny-self-hosted-runners"])
    context = json.loads(run(["docker", "context", "inspect"]))[0]
    (root / "config.json").write_text("{}")
    env = dict(os.environ, DOCKER_CONFIG=str(root), DOCKER_HOST=context["Endpoints"]["docker"]["Host"])
    env.pop("DOCKER_CONTEXT", None)
    env.pop("DOCKER_AUTH_CONFIG", None)
    records = []
    for platform in ["linux/amd64", "linux/arm64"]:
        run(["docker", "pull", "--platform", platform, image], env)
        common = ["docker", "run", "--rm", "--platform", platform, "--read-only",
                  "--cap-drop=ALL", "--security-opt=no-new-privileges", "--network=none"]
        if run(common + [image, "version"], env) != args.version:
            raise RuntimeError("Container version mismatch")
        code = "console.log(JSON.stringify({uid:process.getuid(),hash:new Bun.CryptoHasher('sha256').update(await Bun.file('/opt/bunko/bunko.js').arrayBuffer()).digest('hex')}))"
        actual = json.loads(run(common + ["--entrypoint", "bun", image, "-e", code], env))
        if actual.get("uid") != 65532 or actual.get("hash") != args.cli_sha256:
            raise RuntimeError("Container user or CLI hash mismatch")
        records.append(dict(platform=platform, version=args.version, **actual))
    report = dict(status="passed", image=image, sourceCommit=args.source_commit, records=records)
    destination = root / "verification.json"
    destination.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"status": "passed", "report": str(destination)}))


if __name__ == "__main__":
    main()
