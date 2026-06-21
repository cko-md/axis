// Shared recipe catalogue + helpers used by both the standalone Supper Club
// page (src/components/supper-club/SupperClubModule.tsx) and the Nutrition
// subpanel inside Vitality (src/components/vitality/VitalityModule.tsx).
// Hoisted here so both surfaces show the same data and the same "open in
// in-app browser" behaviour instead of drifting independently.

export type Diet =
  | "high-protein"
  | "mediterranean"
  | "low-carb"
  | "plant-forward"
  | "endurance"
  | "west-african";

export const DIET_LABEL: Record<Diet, string> = {
  "high-protein": "High-Protein",
  mediterranean: "Mediterranean",
  "low-carb": "Low-Carb",
  "plant-forward": "Plant-Forward",
  endurance: "Endurance Fuel",
  "west-african": "West African",
};

export const DIETS = Object.keys(DIET_LABEL) as Diet[];

export type Recipe = {
  id: string;
  t: string;
  diets: Diet[];
  kcal: number | string;
  p?: number;
  time: string;
  src: string;
  g: string;
  mine?: boolean;
  note?: string;
  url?: string;
};

// Open the recipe in the in-app browser. Curated recipes carry a source name but no
// URL, so fall back to a search scoped to the title + source (always resolves).
export function recipeUrl(r: Recipe): string {
  if (r.url) return r.url;
  const src = r.src && r.src !== "Your recipe" ? ` ${r.src}` : "";
  return `https://www.google.com/search?q=${encodeURIComponent(`${r.t}${src} recipe`)}`;
}

export const RECIPES: Recipe[] = [
  { id: "r1", t: "Sheet-Pan Salmon, Sweet Potato & Broccoli", diets: ["high-protein", "endurance", "low-carb"], kcal: 530, p: 42, time: "30 min", src: "Serious Eats", g: "linear-gradient(135deg,#c2603f,#5a2a1f)" },
  { id: "r2", t: "Greek Yogurt Bowl, Berries & Toasted Oats", diets: ["high-protein", "mediterranean"], kcal: 410, p: 32, time: "5 min", src: "Bon Appétit", g: "linear-gradient(135deg,#7a5cc2,#2c2150)" },
  { id: "r3", t: "Chicken, Quinoa & Charred Greens Bowl", diets: ["high-protein", "endurance", "mediterranean"], kcal: 620, p: 48, time: "25 min", src: "NYT Cooking", g: "linear-gradient(135deg,#4f9e6a,#1d3a28)" },
  { id: "r4", t: "Jollof-Spiced Brown Rice & Grilled Chicken", diets: ["high-protein", "west-african", "endurance"], kcal: 640, p: 44, time: "40 min", src: "My Active Kitchen", g: "linear-gradient(135deg,#d06a2c,#5a2510)" },
  { id: "r5", t: "Mediterranean White Bean & Tuna Salad", diets: ["mediterranean", "high-protein", "low-carb"], kcal: 380, p: 34, time: "12 min", src: "The Mediterranean Dish", g: "linear-gradient(135deg,#4a8fb0,#16323f)" },
  { id: "r6", t: "Egusi Soup with Lean Beef & Spinach", diets: ["west-african", "high-protein", "low-carb"], kcal: 560, p: 46, time: "50 min", src: "Sisi Jemimah", g: "linear-gradient(135deg,#5e9e3f,#22381a)" },
  { id: "r7", t: "Tofu & Tempeh Stir-Fry, Sesame Greens", diets: ["plant-forward", "high-protein", "low-carb"], kcal: 440, p: 30, time: "20 min", src: "Minimalist Baker", g: "linear-gradient(135deg,#caa23f,#4a3914)" },
  { id: "r8", t: "Overnight Oats, Banana & Peanut (Pre-Run)", diets: ["endurance", "plant-forward"], kcal: 480, p: 20, time: "5 min + chill", src: "The Run Experience", g: "linear-gradient(135deg,#b8863f,#473015)" },
  { id: "r9", t: "Lentil & Roasted Veg Traybake", diets: ["plant-forward", "mediterranean"], kcal: 430, p: 22, time: "35 min", src: "BBC Good Food", g: "linear-gradient(135deg,#9e5fc2,#341f4f)" },
  { id: "r10", t: "Steak, Eggs & Avocado Power Plate", diets: ["low-carb", "high-protein"], kcal: 610, p: 50, time: "15 min", src: "Diet Doctor", g: "linear-gradient(135deg,#b04f4f,#3a1818)" },
  { id: "r11", t: "Suya-Spiced Turkey Lettuce Wraps", diets: ["west-african", "low-carb", "high-protein"], kcal: 390, p: 40, time: "20 min", src: "Chef Lola’s Kitchen", g: "linear-gradient(135deg,#cc7a2c,#4a2810)" },
  { id: "r12", t: "Pasta with Sardines, Lemon & Chili", diets: ["mediterranean", "endurance"], kcal: 560, p: 30, time: "20 min", src: "NYT Cooking", g: "linear-gradient(135deg,#4a86b0,#16303f)" },
];
