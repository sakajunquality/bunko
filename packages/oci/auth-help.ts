/** Static setup advice only: never include credentials, helper output, or token URLs. */
export function registryAuthHelp(registry: string): string {
  const host = registry.toLowerCase().replace(/:(?:443|80)$/, "");
  const provider = host === "ghcr.io" ? "For GHCR, configure docker login and check package read/write access (including access from the workflow repository)."
    : /^(?:[a-z0-9-]+-docker\.pkg\.dev|(?:[a-z0-9-]+\.)?gcr\.io)$/.test(host) ? "For Google registries, configure the exact host with gcloud auth configure-docker and keep docker-credential-gcloud on PATH; check the active account and repository permissions."
    : /^(?:[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?|public\.ecr\.aws)$/.test(host) ? "For ECR, configure the ecr-login credential helper or refresh docker login with an ECR token; check the AWS identity, region, and repository permissions."
    : ["registry-1.docker.io", "docker.io", "index.docker.io"].includes(host) ? "For Docker Hub, run docker login with an account or access token authorized for the repository."
    : "Configure Docker credentials for the exact registry host and check repository permissions.";
  return `${provider} Bunko reads BUNKO_DOCKER_CONFIG (file), DOCKER_CONFIG/config.json, or ~/.docker/config.json; per-host helpers take precedence over the global store and auths. See docs/REGISTRY_AUTH.md.`;
}
