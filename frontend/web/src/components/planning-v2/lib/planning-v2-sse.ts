/** Lecteur SSE générique (frames `data:` séparées par lignes vides). */

export async function readSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: (evt: Record<string, unknown>) => boolean,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  const flushFrame = (rawFrame: string): boolean => {
    const frame = String(rawFrame || "").trim();
    if (!frame) return false;
    const dataLines = frame
      .split("\n")
      .map((ln) => ln.trim())
      .filter((ln) => ln.startsWith("data:"))
      .map((ln) => ln.replace(/^data:\s*/, ""));
    if (dataLines.length === 0) return false;
    const jsonStr = dataLines.join("\n").trim();
    if (!jsonStr) return false;
    try {
      const evt = JSON.parse(jsonStr) as Record<string, unknown>;
      return onEvent(evt);
    } catch {
      return false;
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      const tail = buffer.trim();
      if (tail) flushFrame(tail);
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    // Serveurs SSE peuvent utiliser \r\n : on normalise pour bien détecter les frames.
    buffer = buffer.replace(/\r/g, "");
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (flushFrame(frame)) return;
    }
  }
}
