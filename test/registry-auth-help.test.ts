import { expect, test } from "bun:test";
import { RegistryError } from "../packages/oci/registry.ts";
import { registryAuthHelp } from "../packages/oci/auth-help.ts";

test("authorization errors include provider-specific setup without raw server text", async () => {
  for (const [host, hint] of [
    ["ghcr.io", "package read/write access"],
    ["asia-northeast1-docker.pkg.dev", "gcloud auth configure-docker"],
    ["123456789012.dkr.ecr.ap-northeast-1.amazonaws.com", "ecr-login"],
    ["registry-1.docker.io", "Docker Hub"],
    ["registry.example.com", "exact registry host"],
  ]) {
    const response = new Response(JSON.stringify({ errors: [{ code: "DENIED", message: "secret-token-must-not-appear" }] }), { status: 403 });
    const error = await RegistryError.response(response, "GET", host!);
    expect(error.message).toContain(hint!);
    expect(error.message).toContain("BUNKO_DOCKER_CONFIG (file)");
    expect(error.message).not.toContain("secret-token-must-not-appear");
  }
});

test("provider advice uses exact host suffixes and does not misclassify immutable tags", () => {
  expect(registryAuthHelp("ghcr.io.attacker.invalid")).not.toContain("For GHCR");
  expect(registryAuthHelp("asia-docker.pkg.dev.attacker.invalid")).not.toContain("For Google");
  expect(new RegistryError(403, "PUT", "ghcr.io", ["DENIED"], true).message).not.toContain("configure docker login");
  expect(new RegistryError(500, "GET", "ghcr.io").message).not.toContain("REGISTRY_AUTH.md");
  expect(new RegistryError(401, "GET", "ghcr.io").message).toContain("For GHCR");
});
