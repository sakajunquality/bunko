/** Complete a chunk before hashing or publishing staged asset bytes. */
export async function writeAssetBytes(handle: { write(bytes: Uint8Array): Promise<{ bytesWritten: number }> }, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes.subarray(offset));
    if (!Number.isInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > bytes.byteLength - offset) throw new Error("Asset file write made invalid progress");
    offset += bytesWritten;
  }
}
