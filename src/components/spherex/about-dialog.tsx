"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export function AboutDialog({ children }: { children?: React.ReactNode }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        {children ?? (
          <Button
            variant="ghost"
            className="h-8 rounded-full px-3 text-[13px] font-medium text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900"
          >
            About
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto rounded-2xl border-black/[0.08] sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold tracking-tight text-neutral-900">
            About SPHEREx Explorer
          </DialogTitle>
          <DialogDescription className="text-[13px] leading-relaxed text-neutral-500">
            A public window into NASA&apos;s all-sky infrared spectroscopic survey.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-[13px] leading-relaxed text-neutral-600">
          <p>
            <span className="font-semibold text-neutral-800">SPHEREx</span> (Spectro-Photometer
            for the History of the Universe, Epoch of Reionization and Ices Explorer) is a NASA
            Medium-Class Explorer mission conducting the first all-sky near-infrared
            spectroscopic survey. It observes the entire sky in 102 spectral channels from 0.75
            to 5.0 microns, producing a uniform dataset that can be compared epoch-to-epoch to
            find moving objects and transient phenomena.
          </p>
          <p>
            This explorer is a prototype for the NASA Space Apps Challenge. It is connected
            directly to the live{" "}
            <span className="font-semibold text-neutral-800">NASA/IPAC IRSA</span> SPHEREx
            archive — every image you see is retrieved on demand from IRSA using the Simple
            Image Access service and the cutout service. No data is simulated, hardcoded or
            cached on disk between sessions.
          </p>
          <div className="rounded-xl border border-black/[0.06] bg-neutral-50/60 p-3">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
              How the comparison works
            </div>
            <ol className="list-decimal space-y-1 pl-4 text-[12px] text-neutral-600">
              <li>Enter a sky position (RA, Dec in degrees).</li>
              <li>The backend queries IRSA SIA for every SPHEREx tile covering that point.</li>
              <li>You pick a band and two observation epochs (A and B).</li>
              <li>
                Cutouts are downloaded with their full FITS WCS (TAN-SIP astrometry), FLAGS,
                VARIANCE and ZODI extensions.
              </li>
              <li>
                Both images are resampled onto a common north-up celestial grid, point sources
                are detected and matched to validate the alignment, and pixels flagged bad
                (cosmic rays, saturation, dead pixels…) are masked.
              </li>
              <li>
                The zodiacal-light model is subtracted, the photometric scale and background
                are normalized, and a signed difference image is produced with candidate
                sources flagged at ≥5σ.
              </li>
            </ol>
          </div>
          <div className="rounded-xl border border-black/[0.06] bg-neutral-50/60 p-3 text-[12px] text-neutral-600">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
              Astrometric accuracy &amp; limitations
            </div>
            <p className="mb-1">
              SPHEREx level-2 astrometry is tied by the mission pipeline to a
              proper-motion-corrected Gaia DR3 reference (sub-arcsecond), so annual aberration,
              stellar parallax and proper motion are already absorbed in the delivered WCS at
              the level relevant for 6.2″ pixels. Residual epoch-to-epoch offsets are measured
              from matched stars and corrected when significant; the remaining alignment error
              is reported in the UI.
            </p>
            <p>
              Not corrected here: parallax of Solar-System objects (their motion is the science
              signal), PSF-matched convolution (different seeing leaves halos around bright
              stars), and absolute flux calibration beyond the fitted scale factor.
            </p>
          </div>
          <div className="rounded-xl border border-amber-200/60 bg-amber-50/50 p-3 text-[12px] text-amber-800">
            <span className="font-semibold">A note on detections:</span> bright spots in the
            difference image are labelled <em>candidate</em> sources only — they may be
            asteroids, comets, planets, variable stars, transients, or residual artefacts.
            Confirmation requires proper orbit/spectrum fitting against a catalogue such as
            JPL Horizons or MPC. Nothing in this tool is a validated detection of a moving
            object.
          </div>
          <p className="text-[11px] text-neutral-400">
            Data source: NASA / IPAC Infrared Science Archive (IRSA), SPHEREx collections{" "}
            <span className="font-mono">spherex_qr2</span> and{" "}
            <span className="font-mono">spherex_qr3</span>. SPHEREx is a NASA mission; this
            interface is an independent citizen prototype and not an official NASA product.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
