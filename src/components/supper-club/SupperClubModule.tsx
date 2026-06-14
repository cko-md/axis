"use client";

import { useRef, useState } from "react";

type Diet =
  | "high-protein"
  | "mediterranean"
  | "low-carb"
  | "plant-forward"
  | "endurance"
  | "west-african";

const DIET_LABEL: Record<Diet, string> = {
  "high-protein": "High-Protein",
  mediterranean: "Mediterranean",
  "low-carb": "Low-Carb",
  "plant-forward": "Plant-Forward",
  endurance: "Endurance Fuel",
  "west-african": "West African",
};

const DIETS = Object.keys(DIET_LABEL) as Diet[];

type Recipe = {
  id: string;
  t: string;
  diets: Diet[];
  kcal: number | string;
  p?: number;
  time: string;
  src: string;
  g: string;
  mine?: boolean;
};

const RECIPES: Recipe[] = [
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

function RecipeCard({
  recipe,
  saved,
  onToggleSave,
}: {
  recipe: Recipe;
  saved: boolean;
  onToggleSave: (id: string) => void;
}) {
  return (
    <div className="recipe">
      <div className="rc-img" style={{ background: recipe.g }}>
        <span className="rc-diet">{recipe.mine ? "Mine" : DIET_LABEL[recipe.diets[0]]}</span>
        {!recipe.mine && (
          <span
            className={`rc-save${saved ? " on" : ""}`}
            title="Save to Supper Club"
            onClick={(e) => {
              e.stopPropagation();
              onToggleSave(recipe.id);
            }}
          >
            {saved ? "★" : "☆"}
          </span>
        )}
      </div>
      <div className="rc-b">
        <div className="rc-t">{recipe.t}</div>
        <div className="rc-meta">
          <span>{recipe.kcal} kcal</span>
          {recipe.p != null && <span>P {recipe.p}g</span>}
          <span>{recipe.time}</span>
        </div>
        <div className="rc-src">{recipe.src} ↗</div>
      </div>
    </div>
  );
}

export function SupperClubModule() {
  const [diet, setDiet] = useState<Diet>("high-protein");
  const [savedIds, setSavedIds] = useState<string[]>(["r1", "r3", "r4"]);
  const [myRecipes, setMyRecipes] = useState<Recipe[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [refreshSeed, setRefreshSeed] = useState(0);
  const titleRef = useRef<HTMLInputElement>(null);
  const timeRef = useRef<HTMLInputElement>(null);
  const kcalRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLInputElement>(null);

  const toggleSave = (id: string) => {
    setSavedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const cycleDiet = () => {
    setDiet((prev) => DIETS[(DIETS.indexOf(prev) + 1) % DIETS.length]);
  };

  const addRecipe = () => {
    const t = titleRef.current?.value || "Untitled";
    const time = timeRef.current?.value || "—";
    const kcal = kcalRef.current?.value || "—";
    setMyRecipes((prev) => [
      {
        id: `mine-${Date.now()}`,
        t,
        diets: [diet],
        kcal,
        time,
        src: "Your recipe",
        g: "linear-gradient(135deg,#3a3f48,#23262b)",
        mine: true,
      },
      ...prev,
    ]);
    [titleRef, timeRef, kcalRef, noteRef].forEach((r) => {
      if (r.current) r.current.value = "";
    });
    setFormOpen(false);
  };

  const pool = RECIPES.filter((r) => r.diets.includes(diet));
  const offset = pool.length ? refreshSeed % pool.length : 0;
  const suggested = pool.slice(offset).concat(pool.slice(0, offset)).slice(0, 8);
  const savedList: Recipe[] = [...myRecipes, ...RECIPES.filter((r) => savedIds.includes(r.id))];
  const savedCount = savedList.length;

  return (
    <>
      <div className="modhead">
        <div className="eyebrow">Life</div>
        <div className="rule" />
        <div className="selectbox" onClick={cycleDiet}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M12 3v18M5 8c0 4 3 5 7 5M19 8c0 4-3 5-7 5" />
          </svg>
          <span>Curate: {DIET_LABEL[diet]}</span>
        </div>
        <div className="savebtn" onClick={() => setRefreshSeed((s) => s + 1)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 4v4h-4" />
          </svg>
          Refresh Sources
        </div>
      </div>
      <h1 className="hero">Supper Club</h1>
      <div className="chips" style={{ marginTop: 18 }}>
        {DIETS.map((d) => (
          <span
            key={d}
            className={`chip${diet === d ? " on" : ""}`}
            onClick={() => setDiet(d)}
          >
            {DIET_LABEL[d]}
          </span>
        ))}
      </div>
      <div
        className="savebtn"
        style={{ display: "inline-flex", marginBottom: 14 }}
        onClick={() => setFormOpen((o) => !o)}
      >
        + Add Recipe
      </div>
      <div className={`recipe-form${formOpen ? " on" : ""}`}>
        <div className="rf-photo">
          <span>+ Photo</span>
        </div>
        <div className="rf-fields">
          <input ref={titleRef} placeholder="Recipe name" />
          <div className="rf-row">
            <input ref={timeRef} placeholder="Time (e.g. 30 min)" />
            <input ref={kcalRef} placeholder="kcal" />
          </div>
          <input ref={noteRef} placeholder="Note / source (optional)" />
          <div className="rf-row">
            <button
              type="button"
              onClick={addRecipe}
              style={{
                margin: 0,
                background: "linear-gradient(100deg,var(--accent),var(--clay))",
                color: "#fff",
                border: "none",
                borderRadius: 7,
                padding: 9,
                fontWeight: 600,
                fontSize: "12.5px",
                cursor: "pointer",
              }}
            >
              Save to Supper Club
            </button>
            <button type="button" className="feed-manage" onClick={() => setFormOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      </div>
      <div className="seclabel">
        Saved <span className="rule" style={{ background: "var(--line)" }} />
        <span style={{ fontFamily: "var(--mono)", fontSize: "9.5px" }}>
          {savedCount} recipe{savedCount === 1 ? "" : "s"}
        </span>
      </div>
      <div className="recipe-grid" style={{ marginBottom: 26 }}>
        {savedList.length ? (
          savedList.map((r) => (
            <RecipeCard key={r.id} recipe={r} saved={savedIds.includes(r.id)} onToggleSave={toggleSave} />
          ))
        ) : (
          <div className="empty" style={{ gridColumn: "1/-1" }}>
            No saved recipes yet — tap the star on any recipe.
          </div>
        )}
      </div>
      <div className="seclabel">
        Suggested · Sourced <span className="rule" style={{ background: "var(--line)" }} />
        <span style={{ fontFamily: "var(--mono)", fontSize: "9.5px" }}>Refreshes weekly</span>
      </div>
      <div className="recipe-grid">
        {suggested.map((r) => (
          <RecipeCard key={r.id} recipe={r} saved={savedIds.includes(r.id)} onToggleSave={toggleSave} />
        ))}
      </div>
    </>
  );
}
