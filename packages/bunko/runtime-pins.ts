// Official release ZIP digests, verified against clear-signed checksum documents.
// New versions require a reviewed pin update; signatures are still required at download time.
export const runtimePins: Record<string, Record<string, string>> = {
  "1.3.13": {
    "bun-linux-x64-baseline": "sha256:9d8a24292a7068090205daac0a5a223f5f69736f5287e37bf88d3b4031edc750",
    "bun-linux-aarch64": "sha256:70bae41b3908b0a120e1e58c5c8af30e74afae3b8d11b0d3fdd8e787ddfb4b22",
    "bun-linux-x64-musl-baseline": "sha256:88ca7c7ad235b498f549eea2f770f434e9f0f5e9ba95168a2d3a1f235184c394",
    "bun-linux-aarch64-musl": "sha256:5385e978107ce4934298d8d6afe9bfbb898683f6cc23e6753a0da60bc60c5b81"
  },
  "1.4.0": {
    "bun-linux-x64-baseline": "sha256:184fb4595f0d401a217cf7c78c1bc430ba83314dab7a8b94805babbf7fa7097f",
    "bun-linux-aarch64": "sha256:4b1a332ee861983eb93bcfe6f770fff94e3e31b2c388bdaea3c8ed35e58eed0e",
    "bun-linux-x64-musl-baseline": "sha256:618c4bc1f94b02337ee210003c0b7c066f11548a8cdc5109df10db043dc47ca2",
    "bun-linux-aarch64-musl": "sha256:576300ce33ff16ffcd455bf178c2f095f9df845c6cc3d0284ba1c96ca0e80473"
  },
  "1.4.1": {
    "bun-linux-x64-baseline": "sha256:a8c9c6738202e2fced555dd860a953c56c0cd059f75041e7010ae81a32802646",
    "bun-linux-aarch64": "sha256:580ce77533108dc6b10bec1721397e4f5aa44e909726da2451d483dfc5e581d6",
    "bun-linux-x64-musl-baseline": "sha256:74d04038a21e6ae816f9e74525b754b85294be99632b336cb4c57019c9313829",
    "bun-linux-aarch64-musl": "sha256:53895807a00508f70e76715947097aa533ec520aac066501c00fb77d2b1a7a6c"
  },
  "1.4.2": {
    "bun-linux-x64-baseline": "sha256:c678040f14fe0440eb839d37cbd0ce4c051a32da72806ac97de6a6aab6bf728f",
    "bun-linux-aarch64": "sha256:54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7",
    "bun-linux-x64-musl-baseline": "sha256:76e1db84e98f22f78de0a87e309bfbbf297732847f9720db36750646c85c8c18",
    "bun-linux-aarch64-musl": "sha256:71760b6c8ea30623b81a4907cb815d48e2ea266f2e73e751534a44a0607950df"
  }
};
