import { Buffer } from "buffer";

const g = globalThis as typeof globalThis & { Buffer?: typeof Buffer; global?: typeof globalThis };
if (!g.Buffer) g.Buffer = Buffer;
if (typeof g.global === "undefined") g.global = g;
