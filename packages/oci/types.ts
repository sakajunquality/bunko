export type Digest = `sha256:${string}`;

export const media = {
  index: "application/vnd.oci.image.index.v1+json",
  manifest: "application/vnd.oci.image.manifest.v1+json",
  config: "application/vnd.oci.image.config.v1+json",
  tar: "application/vnd.oci.image.layer.v1.tar",
  gzip: "application/vnd.oci.image.layer.v1.tar+gzip",
  dockerIndex: "application/vnd.docker.distribution.manifest.list.v2+json",
  dockerManifest: "application/vnd.docker.distribution.manifest.v2+json",
  dockerConfig: "application/vnd.docker.container.image.v1+json",
  dockerGzip: "application/vnd.docker.image.rootfs.diff.tar.gzip",
} as const;

export interface Platform {
  os: "linux";
  architecture: "amd64" | "arm64";
  variant?: string;
}

export interface Descriptor {
  mediaType: string;
  digest: Digest;
  size: number;
  platform?: Platform;
  annotations?: Record<string, string>;
  artifactType?: string;
}

export interface ImageIndex {
  schemaVersion: 2;
  mediaType: string;
  manifests: Descriptor[];
}

export interface ImageManifest {
  schemaVersion: 2;
  mediaType: string;
  config: Descriptor;
  layers: Descriptor[];
}

export interface RuntimeConfig {
  User?: string;
  Env?: string[];
  Entrypoint?: string[];
  Cmd?: string[];
  WorkingDir?: string;
  ExposedPorts?: Record<string, Record<string, never>>;
  Labels?: Record<string, string>;
  Volumes?: Record<string, Record<string, never>>;
  StopSignal?: string;
}

export interface ImageConfig {
  architecture: string;
  os: string;
  variant?: string;
  created?: string;
  author?: string;
  config?: RuntimeConfig;
  rootfs: { type: "layers"; diff_ids: Digest[] };
  history?: { created?: string; created_by?: string; empty_layer?: boolean; comment?: string }[];
}

export interface Layer {
  kind: "app" | "assets" | "deps";
  descriptor: Descriptor;
  diffId: Digest;
}

export interface BaseImage {
  manifest: ImageManifest;
  descriptor: Descriptor;
  config: ImageConfig;
  indexDigest?: Digest;
}
