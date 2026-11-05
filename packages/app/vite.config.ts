import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ["react", "react-dom"] },
  optimizeDeps: { include: ["react", "react-dom", "gsap", "gsap/ScrollTrigger", "@gsap/react", "motion/react"] },
  server: { port: 5180, strictPort: true },
});
