import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
	root: fileURLToPath(new URL(".", import.meta.url)),
	base: "/",
	esbuild: { jsx: "automatic" },
	build: {
		outDir: "dist",
		emptyOutDir: true,
		target: "es2023",
	},
});
