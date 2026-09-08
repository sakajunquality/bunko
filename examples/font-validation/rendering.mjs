/** Use both families when rendering mixed CJK and emoji text with Canvas. */
export const canvasFont = ["Noto Sans CJK JP", "Noto Color Emoji"];

/** Both recipes discover all vendored faces without a per-file registration list. */
export function resvgFonts(recipe = "fontconfig") {
  const defaultFontFamily = "Noto Sans CJK JP";
  if (recipe === "fontconfig") return { loadSystemFonts: true, defaultFontFamily };
  if (recipe === "directories") return { loadSystemFonts: false, fontDirs: ["/usr/share/fonts/bunko"], defaultFontFamily };
  throw new Error("FONT_DISCOVERY must be fontconfig or directories");
}
