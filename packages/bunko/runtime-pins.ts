// Official release ZIP digests, verified against clear-signed checksum documents.
// New versions require a reviewed pin update; signatures are still required at download time.
export const runtimePins: Record<string, Record<string, string>> = {
  "1.3.11": {
    "bun-linux-x64-baseline": "sha256:abe346f63414547cdf6b35b7a649a490c728b93d006226156923918a84c0e59b",
    "bun-linux-aarch64": "sha256:d13944da12a53ecc74bf6a720bd1d04c4555c038dfe422365356a7be47691fdf"
  },
  "1.3.12": {
    "bun-linux-x64-baseline": "sha256:f8bb377a9ae93d44697ff91a2611164d2aedc9263415d623b0c3af24a6f55dab",
    "bun-linux-aarch64": "sha256:c40bc0ebca11bde7d75af497a654a874d0c7fd8d6a8d6031c173c10c9064297b"
  },
  "1.3.13": {
    "bun-linux-x64-baseline": "sha256:9d8a24292a7068090205daac0a5a223f5f69736f5287e37bf88d3b4031edc750",
    "bun-linux-aarch64": "sha256:70bae41b3908b0a120e1e58c5c8af30e74afae3b8d11b0d3fdd8e787ddfb4b22"
  }
};
