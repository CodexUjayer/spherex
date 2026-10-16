/// <reference types="bun-types" />
/**
 * Archive-access robustness tests (Task 9.11): streamCutout retry/backoff on
 * transient IRSA failures (503 "Server busy" is common under bursts), clean
 * failure on hard errors, and graceful handling of malformed FITS payloads —
 * exercised against a local HTTP server (no external network needed).
 */

import { describe, expect, test, afterAll } from "bun:test";
import { streamCutout, readSpherexFits, cutoutUrl } from "@/lib/spherex/fits";
import { buildFits } from "./helpers/fits-builder";

const WCS = { scaleDeg: 6.15 / 3600, paDeg: 30, crpix: [16.5, 16.5] as [number, number], crval: [150, 2] as [number, number] };

const goodFits = buildFits({
  width: 32, height: 32,
  image: new Float32Array(32 * 32).fill(1),
  wcs: WCS,
});

let hits = 0;
const server = Bun.serve({
  port: 3999,
  fetch(req) {
    hits++;
    const url = new URL(req.url);
    if (url.pathname === "/flaky") {
      // fail twice with 503 (like IRSA "Server busy"), then serve the FITS
      if (hits % 3 !== 0) {
        return new Response("Server busy, retry later.", { status: 503 });
      }
      return new Response(new Uint8Array(goodFits));
    }
    if (url.pathname === "/hardfail") {
      return new Response("Not Found", { status: 404 });
    }
    if (url.pathname === "/garbage") {
      return new Response("this is definitely not a FITS file");
    }
    if (url.pathname === "/slow") {
      // never responds within the timeout
      return new Promise(() => {}) as unknown as Response;
    }
    return new Response("not found", { status: 404 });
  },
});

afterAll(() => {
  server.stop(true);
});

describe("streamCutout robustness", () => {
  test("retries transient 503s and succeeds", async () => {
    hits = 0;
    const buf = await streamCutout("http://localhost:3999/flaky", 5000, [50, 100]);
    expect(buf.length).toBeGreaterThan(2880 * 4);
    // two failures + one success
    expect(hits).toBe(3);
    const fd = readSpherexFits(buf);
    expect(fd.width).toBe(32);
  });

  test("hard failures (404) surface as errors, not empty data", async () => {
    hits = 0;
    await expect(streamCutout("http://localhost:3999/hardfail", 5000)).rejects.toThrow();
  });

  test("malformed FITS payload is rejected by the reader", async () => {
    const buf = await streamCutout("http://localhost:3999/garbage", 5000).catch(() => null);
    if (buf) {
      // if the payload came through, the reader must reject it
      expect(() => readSpherexFits(buf)).toThrow();
    }
  });

  test("timeout aborts rather than hanging forever", async () => {
    hits = 0;
    await expect(streamCutout("http://localhost:3999/slow", 300, [50])).rejects.toThrow();
  }, 10000);
});

describe("cutoutUrl builder", () => {
  test("appends center/size with the documented IRSA format", () => {
    const u = cutoutUrl("https://irsa.ipac.caltech.edu/ibe/data/x.fits", 83.821, -53.937, 0.3);
    expect(u).toBe("https://irsa.ipac.caltech.edu/ibe/data/x.fits?center=83.821,-53.937&size=0.3");
    const u2 = cutoutUrl("https://irsa.ipac.caltech.edu/ibe/data/x.fits?existing=1", 1, 2, 0.1);
    expect(u2).toContain("&center=1,2&size=0.1");
  });
});
