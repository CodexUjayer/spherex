"use client";

import { useState } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { SpherexExample } from "@/lib/spherex-api";

interface SearchPanelProps {
  examples: SpherexExample[];
  onSearch: (ra: number, dec: number) => void;
  loading: boolean;
}

function parseRaDec(s: string): { ra: number; dec: number } | null {
  const m = s.trim().match(/^([+-]?\d*\.?\d+)\s*[,\s]\s*([+-]?\d*\.?\d+)$/);
  if (!m) return null;
  const ra = parseFloat(m[1]);
  const dec = parseFloat(m[2]);
  if (ra < 0 || ra > 360 || dec < -90 || dec > 90) return null;
  return { ra, dec };
}

export function SearchPanel({ examples, onSearch, loading }: SearchPanelProps) {
  const [text, setText] = useState("83.821, -53.937");

  const submit = () => {
    const r = parseRaDec(text);
    if (r) onSearch(r.ra, r.dec);
  };

  return (
    <div>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-neutral-400" />
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Search a position, object, or RA / Dec"
            className="h-11 rounded-lg border-neutral-300 bg-white pl-9 text-[15px] font-medium text-neutral-900 placeholder:font-normal placeholder:text-neutral-400 focus-visible:ring-blue-300"
          />
        </div>
        <Button
          onClick={submit}
          disabled={loading || !parseRaDec(text)}
          className="h-11 rounded-lg bg-neutral-900 px-5 text-[14px] font-medium text-white transition hover:bg-neutral-700 disabled:opacity-40"
        >
          {loading ? "Searching" : "Explore"}
        </Button>
      </div>
      <p className="mt-1.5 text-[12px] text-neutral-500">
        Example: RA 83.821°, Dec -53.937°. Every result is live NASA/IPAC IRSA SPHEREx data.
      </p>
    </div>
  );
}
