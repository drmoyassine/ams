/** The file's bytes (an upload body): `Blob.arrayBuffer` where it exists, a FileReader where it does not (older browsers, jsdom). */
export function readBytes(file: Blob): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as ArrayBuffer);
    r.onerror = () => reject(r.error ?? new Error('could not read the file'));
    r.readAsArrayBuffer(file);
  });
}
