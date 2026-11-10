// Platzhalter für "stream/promises": PGlite importiert es nur unter Node.js
// (Entpacken von Erweiterungen); im Browser wird dieser Pfad nie ausgeführt.
export function pipeline(): never {
  throw new Error("stream/promises ist im Browser nicht verfügbar");
}
export default { pipeline };
