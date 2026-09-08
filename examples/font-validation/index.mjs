import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { Resvg } from "@resvg/resvg-js";

const root = "/usr/share/fonts/bunko";
const cjk = `${root}/NotoSansCJKjp-Regular.otf`, emoji = `${root}/NotoColorEmoji.ttf`;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert(GlobalFonts.has("Noto Sans CJK JP"), "Canvas did not discover the CJK system font");
assert(GlobalFonts.has("Noto Color Emoji"), "Canvas did not discover the emoji system font");
function canvas(text, family) {
  const image = createCanvas(400, 90), context = image.getContext("2d");
  context.font = `40px "${family}"`; context.fillText(text, 5, 60);
  return context.getImageData(0, 0, 400, 90).data;
}
const automatic = canvas("日本語漢字", "Noto Sans CJK JP"), automaticEmoji = canvas("😀🎉", "Noto Color Emoji");
assert(automatic.some((value, index) => index % 4 === 3 && value > 0), "CJK output is empty");
assert(automaticEmoji.some((value, index) => index % 4 === 0 && value !== automaticEmoji[index + 1] && automaticEmoji[index + 3] > 0), "Emoji output has no colored pixels");
assert.equal(digest(automaticEmoji), digest(canvas("😀🎉", "Noto Sans CJK JP")), "Canvas did not fall back from CJK to the system emoji face");
assert(GlobalFonts.registerFromPath(cjk, "Explicit CJK"));
assert(GlobalFonts.registerFromPath(emoji, "Explicit Emoji"));
assert.equal(digest(automatic), digest(canvas("日本語漢字", "Explicit CJK")));
assert.equal(digest(automaticEmoji), digest(canvas("😀🎉", "Explicit Emoji")));

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="90"><text x="5" y="60" font-size="40" font-family="Noto Sans CJK JP">日本語漢字</text></svg>';
const render = (font) => new Resvg(svg, { font }).render().pixels;
const system = render({ loadSystemFonts: true });
const explicit = render({ loadSystemFonts: false, fontFiles: [cjk] });
const absent = render({ loadSystemFonts: false });
assert.equal(digest(system), digest(explicit), "Resvg system discovery differs from explicit CJK registration");
assert.notEqual(digest(system), digest(absent), "Resvg output is unchanged without fonts");
console.log(JSON.stringify({ status: "passed", arch: process.arch, canvasCJK: digest(automatic), canvasColorEmoji: digest(automaticEmoji), resvgCJK: digest(system), systemDiscovery: true, explicitRegistrationMatches: true }));
