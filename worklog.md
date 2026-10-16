# SPHEREx Explorer — Shared Worklog

Repo: https://github.com/CodexUjayer/spherex (branch `main` @ 6f9d83f)
Working branch: `science/wcs-registration`
Runnable instance: `/home/z/my-project` (Next.js dev server, port 3000)

---
Task ID: 1
Agent: main (orchestrator)
Task: Phase A+B — Clone repo, baseline run, full audit of the data flow and scientific defects

Work Log:
- Cloned https://github.com/CodexUjayer/spherex (main @ 6f9d83f) to /home/z/spherex-repo; created branch science/wcs-registration.
- Audited all source: src/lib/spherex/{sia,fits,imageproc}.ts, src/lib/spherex-api.ts, all API routes, page.tsx, sky-viewer/timeline/coord-grid components. Legacy: mini-services/spherex-api (Python) is unused by the Next app.
- Ported the app into /home/z/my-project (identical scaffold; added pngjs dep), dev server runs; live IRSA search/image/preview verified (curl 200s).
- Verified live IRSA SIA (spherex_qr2 AND spherex_qr3 both exist; epochs are DISJOINT: qr2 = 2025-08→2026-03, qr3 = 2026-08→2026-09, obs_id overlap 0).
- Fetched real cutout FITS and fully decoded the MEF structure: HDU1 IMAGE (MJy/sr, TAN-SIP WCS: PC+CDELT with CDELT=1, SIP A/B + AP/BP order 3, negative CRPIX because cutouts keep parent-frame WCS), HDU2 FLAGS (int32, bit table from Explanatory Supplement Table 16: TRANSIENT=0 OVERFLOW=1 SUR_ERROR=2 NONFUNC=6 DICHROIC=7 MISSING_DATA=9 HOT=10 COLD=11 FULLSAMPLE=12 PHANMISS=14 NONLINEAR=15 PERSIST=17 OUTLIER=19 CROSSTALK=20 SOURCE=21 GHOST=22 GHOST_FPA=23 GHOST_EXT=24 STREAK=25 BLOOM=26 SNOWBALL=27 HALO=28 SATELLITE_HALO=29; header also carries MP_* bit keywords), HDU3 VARIANCE, HDU4 ZODI, HDU5 PSF (~5MB).
- Validated complete WCS math (gnomonic TAN + SIP fwd/inv + PC⊗CDELT + FITS 1-based CRPIX) numerically against a real cutout: requested center lands at image center within 0.7px, round-trip error <0.003px, pixel scale matches SIA s_pixel_scale.
- IRSA cutout endpoint intermittently returns 503 "Server busy" under rapid requests — recovers after ~15s; app needs retry/backoff.
- Official docs consulted: SPHEREx cutout tool page (URL format confirmed: ?center=RA,Dec&size=deg), spherex-archive-documentation (HDU structure; mosaic tool practice: subtract ZODI, mask bad flags, reproject to common grid), Explanatory Supplement (flags Table 16, fine astrometry = proper-motion-corrected Gaia DR3 fit, sub-arcsec).

Phase B — defects found (with evidence):
1. compare/route.ts subtracts images by pixel index ("both cutouts are centred on the same sky position, so their pixel grids align" — false). PROOF: two fully-covering 176x176 D2 cutouts of (83.821,-53.937) from different epochs have PA -98.57° vs +81.35° → ~180° relative rotation + different CRPIX/CRVAL. The difference image is meaningless; slider/side views are misaligned.
2. fits.ts ignores WCS entirely; prior dev misdiagnosed CDELT=1.0 as "dummy" (scale actually lives in the PC matrix) and abandoned header WCS for a linear north-up approximation.
3. coord-grid/cursor assumes north-up linear mapping; real cutouts are rotated (~±98°/±82°) → cursor RA/Dec readout systematically wrong for raw cutouts.
4. sia.ts dateIso = obs_release_date ?? mjdToIso(t_min) — displays the RELEASE date as the observation date (verified live: app showed 2026-03-03 release date for an obs taken 2026-01-21).
5. dedupeByDate collapses by t_min.toFixed(4) — hides legitimately distinct same-date observations; same obs_id legitimately maps to 2 products (detectors D3+D6 = different bands); wrong identity key.
6. computeDifference uses Math.min(a.length,b.length) — silently truncates dimension mismatches (partial cutouts DO occur, e.g. 176x77 when tile coverage is partial).
7. No FLAGS/VARIANCE/ZODI usage; no masking of saturated (OVERFLOW), cosmic rays (TRANSIENT), dead pixels, etc. Official mosaic policy not followed.
8. No band compatibility check in compare; no background/photometric-scale normalization before subtraction; no registration diagnostics.
9. Collection hardcoded to spherex_qr2; QR3 exists with later disjoint epochs — merging gives the full time baseline (defensible: zero obs_id overlap, dedupe defensively by (obs_id, band, url)).
10. streamCutout has no retry; IRSA 503s surface directly to users.
11. No automated tests at all (tests/ contains only build scripts).

Stage Summary:
- Baseline app runs with live IRSA data; all scientific defects confirmed with live evidence. Implementation order fixed: metadata (sia) → WCS+registration → masking/normalization → star validation → UI diagnostics → tests.

---
Task ID: 3-b/c/d/e/f + 4 + 5
Agent: main (orchestrator)
Task: Phase C+D — implement WCS registration, star matching, scientific difference imaging, metadata fixes, UI diagnostics, and the automated test suite

Work Log:
- NEW src/lib/spherex/wcs.ts — WCS parser+transforms: CD / PC⊗CDELT / CDELT forms; TAN (gnomonic) + SIP (forward A/B, inverse AP/BP), CAR, SIN; negative (cutout) CRPIX handled via the standard (x+1−CRPIX) formulation; round-trip validation helper; makeTanWcs common-grid builder (north-up, east-left: CD=[[−s,0],[0,−s]] for row-0-at-top PNG rendering). Numerically validated against a REAL SPHEREx header (requested center lands at cutout center within 0.7 px; round-trip <0.003 px; scale matches s_pixel_scale). Fixed two hard bugs found by validation: DEC--TAN-SIP two-hyphen CTYPE regex, and a wrong orthographic (SIN) inverse.
- NEW src/lib/spherex/reproject.ts — common-grid reprojection: buildCommonGrid (finest of the two scales, centered on the requested position), bicubic (Catmull-Rom) sampling with bilinear fallback, conservative validity (4/16 neighbours valid), 1-px mask dilation, sky-position cache, similarity-transform resampler for the no-WCS fallback. Fixed the critical half-pixel sampling-convention bug (x−0.5 pixel-edge convention misaligned rotated pairs by ~0.7–1 px — exactly the flipped-epoch case).
- NEW src/lib/spherex/stars.ts — point-source detection (matched-filter smoothing, sigma-clipped background, 3×3 maxima, windowed centroids, aperture flux, isolation/edge filters), WCS matching with mutual nearest-neighbour + MAD outlier rejection + median-shift refinement, and a documented triangle-signature geometric fallback (rotation+scale+translation, RANSAC vote + least-squares similarity refinement). Constellation shapes are NEVER used — only measurable individual sources.
- NEW src/lib/spherex/diffimg.ts — band compatibility gate (≥50% wavelength overlap, same calib level), PSF homogenization (both epochs broadened to max(σA,σB,0.9 px) — the symmetric cousin of Alard&Lupton matching, also suppressing interpolation-phase noise), matched-star photometric scaling (apertures measured on the homogenized pair with annulus backgrounds — unbiased across pixel scales) with robust pixel-fit fallback, sigma-clipped background offset, SIGNED difference, 5σ connected-component candidate detection.
- NEW src/lib/spherex/compare-pipeline.ts — orchestrator (pure, network-free): band gate → WCS parse+roundtrip validation → flag-masked, zodi-subtracted rasters (official mosaic-tool policy, Expsupp §3.4.3; OVERFLOW+OUTLIER additionally masked for difference work) → native-frame star detection → WCS matching (+constant-shift refinement when significant) → common-grid reprojection → normalization/difference/candidates → renders (originals + aligned pair + consistent ±5σ difference stretch) → registration diagnostics. WCS-contradicted cases (sources present but unmatched) fall back to geometric registration or are BLOCKED; too-few-stars cases are flagged low-confidence, never fabricated.
- REWRITTEN src/lib/spherex/fits.ts — reads IMAGE+FLAGS+VARIANCE+ZODI (streams through VARIANCE, aborts before the ~5 MB PSF); canonical FLAG bit table (Expsupp Table 16) with MP_* header overrides; HIERARCH long-keyword parsing; quoted values with embedded '/' (BUNIT 'MJy / sr') parse correctly; retry/backoff (502/503/504/429, 1.5/4/9/16 s) for IRSA "Server busy" bursts; extended metadata (MJD-BEG/END/AVG, XPOSURE, PSF_FWHM, OBSID, DETECTOR).
- REWRITTEN src/lib/spherex/sia.ts — observation time now derived from t_min (NEVER the release date; obs_release_date exposed separately as release_iso), identity-based dedup by (obs_id, band, access_url) with newest-release-wins across collections (preserves legitimate same-date observations and multi-detector products), multi-collection query (spherex_qr2 + spherex_qr3 in parallel, SPHEREX_COLLECTIONS env override) — QR2 (2025-08→2026-03) and QR3 (2026-08→2026-09) are epoch-disjoint with zero obs_id overlap (verified live), so merging gives the full time baseline.
- src/lib/spherex/imageproc.ts — metaFromFits exposes the real FITS WCS (cd/crpix/crval/scale/PA) for client-side cursor readout; renderDifferencePng accepts the pipeline's robust σ so every panel shares ONE stretch.
- src/app/api/compare/route.ts — rewritten around comparePipeline: accepts band/wavelength/calib/release metadata from the client's SIA selection (FITS DETECTOR fallback); returns aligned pair (image_a/b), originals (image_a_orig/b_orig), difference, registration diagnostics, warnings, band_compatibility; 409 + reason for scientifically invalid pairs; 502 for upstream failures.
- src/app/api/{search,preview}/route.ts — collection merge + response includes collections; identity dedup.
- src/lib/spherex-api.ts + page.tsx + sky-viewer.tsx + coord-grid.ts + timeline.tsx + about-dialog.tsx — new types; difference mode uses the ALIGNED pair for slider/subtract and the ORIGINAL native-grid cutouts for side-by-side (labelled); real-WCS cursor readout (fixes the wrong RA/Dec on rotated raw cutouts); registration panel (method, matched stars, RMS, normalization, coverage, PSF/PSF-homogenization warnings); observation-vs-release dates shown separately; collection-aware footer/info; honest methodology + limitations text in About.
- Tests (bun test): tests/wcs.test.ts (16), tests/fits.test.ts (7), tests/stars.test.ts (8), tests/diffimg.test.ts (12), tests/registration.test.ts (7), tests/sia-meta.test.ts (8), tests/live-retry.test.ts (6) + helpers (synthetic FITS builder, deterministic sky-scene renderer). 64/64 pass. Includes the required demonstrations: a known 0.8 px astrometric offset is measured+refined away (the old pixel-index subtraction of the same pair shows a large spurious dipole pattern); 180°-flipped, 2.5%-rescaled epochs register (matched-star RMS <0.6 px) with an injected transient detected at the right position with correct sign and dominating the candidate list; identical content through different geometry produces no bright false candidates; missing WCS uses the documented geometric fallback; too-few-stars/no-WCS is explicitly blocked; band-incompatible pairs rejected before processing; observation-vs-release date and dedup semantics verified; 503-retry and malformed-FITS handling verified against a local server.

Verification (Phase D):
- bun run lint: clean. tsc --noEmit: clean (project files). bun test: 64/64 pass.
- Live IRSA verified: search (qr2+qr3 merged, 256 obs at default position; D2 spans 2025-08-27→2026-09-04), image cutouts, compare on the 180°-rotated epoch pair: 148 matched stars, residual RMS 1.567″ (0.26 px), flags masked (2.9%/3.5%), PSF homogenized, scale from 26 stars; second position (Orion): 74–80 matched stars, RMS 2.2–3.2″; timeline drag re-triggers comparison correctly; band-incompatible API call blocked with 409 + reason.
- Agent Browser: full UI verified on desktop + mobile (no overflow, footer bottom, viewer modes single/blink/difference × slider/side-by-side/subtract all working, registration panel + warnings render, gallery previews load); console clean apart from a benign controlled/uncontrolled Select warning.
- IRSA intermittently rate-limits under load (some cutouts took 30–50 s and needed retries) — the retry logic carried every request through; no silent failures observed.

Stage Summary:
- The comparison pipeline is now scientifically defensible end-to-end: real FITS WCS (TAN-SIP) registration onto a common celestial grid, reference-star validation with outlier rejection and residual reporting, official bad-flag masking + zodiacal subtraction, PSF homogenization, star-based photometric normalization, signed differences with honest unconfirmed-candidate labelling, and explicit blocking/flagging of anything that cannot be registered or is scientifically incompatible. All 64 automated tests pass; live NASA/IPAC IRSA retrieval and comparison verified end-to-end in the browser.

---
Task ID: 6
Agent: main (orchestrator)
Task: Phase E — quality review, browser verification, git commit

Work Log:
- Removed temporary debug scripts (.scratch-debug).
- Verified no regressions: lint clean, tsc clean, 64/64 tests pass, dev server serves the full UI (desktop 1280px + mobile 390px, no horizontal overflow, footer at bottom), all viewer modes functional with live IRSA data.
- Committed on branch science/wcs-registration, commit a1e5dea (27 files changed, +4583/−251) in /home/z/spherex-repo.
- Push attempted: FAILED — no GitHub credentials in this environment (git asks for username non-interactively). The branch + commit exist locally and are ready to push.

Stage Summary:
- Deliverable runnable at /home/z/my-project (bun run dev, port 3000) and committed in /home/z/spherex-repo @ a1e5dea (branch science/wcs-registration). Push requires credentials not present in this environment.
