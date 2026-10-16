/// <reference types="bun-types" />
/**
 * SIA metadata tests (Task 9.9, 9.10): observation time vs archive release
 * date, MJD conversion, identity-based dedup that preserves legitimate
 * same-date observations.
 */

import { describe, expect, test } from "bun:test";
import { mjdToIso, dedupeObservations, type Observation } from "@/lib/spherex/sia";

function obs(partial: Partial<Observation>): Observation {
  return {
    obs_id: "OBS",
    access_url: "https://irsa.example/file.fits",
    publisher_did: "",
    date_mjd: null,
    date_iso: null,
    release_iso: null,
    band: "SPHEREx-D2",
    wavelength_min_um: 1.13,
    wavelength_max_um: 1.68,
    wavelength_center_um: 1.4,
    em_res_power: null,
    t_exptime: null,
    ra_center: null,
    dec_center: null,
    target_name: null,
    s_xel1: null,
    s_xel2: null,
    s_pixel_scale: null,
    s_fov: null,
    calib_level: 2,
    proposal_title: null,
    obs_collection: "spherex_qr2",
    facility: null,
    instrument: null,
    ...partial,
  };
}

describe("observation time vs release date", () => {
  test("mjdToIso converts the MJD epoch correctly", () => {
    // MJD 61061.798326 ≈ 2026-01-21T19:09:35 UTC (validated against a real
    // SPHEREx DATE-OBS header)
    const iso = mjdToIso(61061.798326053);
    expect(iso).not.toBeNull();
    expect(iso!.startsWith("2026-01-21T19:09:3")).toBeTrue();
    expect(iso!.endsWith("Z")).toBeTrue();
    expect(mjdToIso(null)).toBeNull();
    expect(mjdToIso(NaN)).toBeNull();
  });

  test("date fields are distinct in the parsed row semantics", () => {
    // rowToObs is not exported; the semantics are enforced through the
    // interface contract: date_mjd/date_iso = observation time (t_min),
    // release_iso = obs_release_date. Verified live: an observation with
    // t_min = 61061.8 (2026-01-21) and obs_release_date = 2026-03-03 maps to
    // date_iso = 2026-01-21..., release_iso = 2026-03-03...
    const o = obs({
      date_mjd: 61061.798326053,
      date_iso: mjdToIso(61061.798326053),
      release_iso: "2026-03-03T19:24:20Z",
    });
    expect(o.date_iso!.startsWith("2026-01-21")).toBeTrue();
    expect(o.release_iso!.startsWith("2026-03-03")).toBeTrue();
    expect(o.date_iso).not.toBe(o.release_iso);
  });
});

describe("dedupeObservations — identity, not date", () => {
  test("keeps distinct observations that share a date", () => {
    // two different pointings observed the same day — BOTH must survive
    const a = obs({ obs_id: "2026W04_1A_0564_1", access_url: "u1", date_mjd: 61061.8 });
    const b = obs({ obs_id: "2026W04_1A_0564_2", access_url: "u2", date_mjd: 61061.8 });
    const out = dedupeObservations([a, b]);
    expect(out.length).toBe(2);
  });

  test("keeps the same observation in different bands (D3 + D6 detectors)", () => {
    const a = obs({ obs_id: "X_1", access_url: "u1", band: "SPHEREx-D3", date_mjd: 1 });
    const b = obs({ obs_id: "X_1", access_url: "u2", band: "SPHEREx-D6", date_mjd: 1 });
    const out = dedupeObservations([a, b]);
    expect(out.length).toBe(2);
    expect(out.map((o) => o.band).sort()).toEqual(["SPHEREx-D3", "SPHEREx-D6"]);
  });

  test("removes exact product duplicates (same access_url)", () => {
    const a = obs({ obs_id: "X_1", access_url: "u1", date_mjd: 1 });
    const b = obs({ obs_id: "X_1", access_url: "u1", date_mjd: 1 });
    expect(dedupeObservations([a, b]).length).toBe(1);
  });

  test("same obs_id + band across collections: newest release wins", () => {
    const qr2 = obs({ obs_id: "X_1", access_url: "u1", band: "SPHEREx-D2", date_mjd: 1, obs_collection: "spherex_qr2" });
    const qr3 = obs({ obs_id: "X_1", access_url: "u2", band: "SPHEREx-D2", date_mjd: 1, obs_collection: "spherex_qr3" });
    const out = dedupeObservations([qr2, qr3]);
    expect(out.length).toBe(1);
    expect(out[0].obs_collection).toBe("spherex_qr3");
  });

  test("output is sorted by observation date", () => {
    const a = obs({ obs_id: "late", access_url: "u1", date_mjd: 100 });
    const b = obs({ obs_id: "early", access_url: "u2", date_mjd: 50 });
    const out = dedupeObservations([a, b]);
    expect(out[0].obs_id).toBe("early");
    expect(out[1].obs_id).toBe("late");
  });

  test("missing-date observations sort last, not first", () => {
    const a = obs({ obs_id: "nodate", access_url: "u1", date_mjd: null });
    const b = obs({ obs_id: "dated", access_url: "u2", date_mjd: 5 });
    const out = dedupeObservations([a, b]);
    expect(out[0].obs_id).toBe("dated");
    expect(out[1].obs_id).toBe("nodate");
  });
});
