import { useEffect, useRef, useState } from "react";

/** A muted loop that downloads only when it is about to scroll into view, and pauses off-screen. */
export function LazyVideo({ src, poster }: { src: string; poster: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [load, setLoad] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { setLoad(true); void el.play().catch(() => undefined); } else el.pause();
    }, { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return <video ref={ref} src={load ? src : undefined} poster={poster} muted loop playsInline preload="none" />;
}
