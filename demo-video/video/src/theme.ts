// Vox-style palette and type (from Vox-Style-Motion-mcp specs/design-tokens.json), plus the Octopus app colours.
import { loadFont as loadPlayfair } from "@remotion/google-fonts/PlayfairDisplay";
import { loadFont as loadAnton } from "@remotion/google-fonts/Anton";
import { loadFont as loadCourier } from "@remotion/google-fonts/CourierPrime";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";

const playfair = loadPlayfair("italic", { weights: ["400", "700", "900"], subsets: ["latin"] });
const anton = loadAnton("normal", { weights: ["400"], subsets: ["latin"] });
const courier = loadCourier("normal", { weights: ["400", "700"], subsets: ["latin"] });
const inter = loadInter("normal", { weights: ["400", "500", "600", "700"], subsets: ["latin"] });

export const FONT = {
  headline: `${playfair.fontFamily}, Georgia, serif`,
  number: `${anton.fontFamily}, Impact, sans-serif`,
  typewriter: `${courier.fontFamily}, "Courier New", monospace`,
  ui: `${inter.fontFamily}, system-ui, sans-serif`,
};

export const C = {
  paper: "#EBE5DC",
  vignetteMid: "#D4CEC2",
  vignetteCorner: "#BDB5AA",
  ink: "#171310",
  inkSoft: "#3A3530",
  red: "#D2251D",
  redDark: "#7A1612",
  yellow: "#F1D01A",
  grey: "#756F6A",
  greyText: "#8A847D",
  pale: "#B9B2A8",
  card: "#F7F3EB",
  tag: "#F4F0E9",
  white: "#FFFFFF",
  black: "#000000",
  onBlack: "#F3F0EB",
  onBlackDim: "#736F6B",
  // Octopus app
  app: "#1F1E1D",
  appBar: "#2A2927",
  coral: "#D97756",
  green: "#6B8440",
  // Chai Tapri site
  chaiGreen: "#234238",
  chaiGold: "#D9992F",
};
