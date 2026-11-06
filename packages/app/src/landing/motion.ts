import { useEffect, useState } from "react";

/** false when the visitor asked for reduced motion: no autoplaying video, no scroll choreography. */
export function useMotionOk() {
  const q = "(prefers-reduced-motion: no-preference)";
  const [ok, setOk] = useState(() => typeof matchMedia === "undefined" || matchMedia(q).matches);
  useEffect(() => {
    const m = matchMedia(q);
    const on = () => setOk(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return ok;
}
