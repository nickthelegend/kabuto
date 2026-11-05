import { useEffect, useState } from "react";
import { Dex } from "./Dex";
import { Landing } from "./Landing";

function useRoute() {
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => {
    const on = () => { setHash(location.hash); if (location.hash.startsWith("#/")) window.scrollTo(0, 0); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash.startsWith("#/app") ? "app" : "home";
}

export function App() {
  return useRoute() === "app" ? <Dex /> : <Landing />;
}
