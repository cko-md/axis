"use client";

import { useEffect, useRef, useState } from "react";
import { useWebViewer } from "@/lib/hooks/useWebViewer";
import { DIET_LABEL, DIETS, RECIPES, recipeUrl, type Diet, type Recipe } from "@/lib/recipes";

const SAVED_KEY   = "axis-supper-saved";
const RECIPES_KEY = "axis-supper-recipes";
const DIET_KEY    = "axis-supper-diet";

function proxyImage(url: string): string {
  return `/api/og-image?url=${encodeURIComponent(url)}`;
}

function RecipeImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={proxyImage(src)}
      alt={alt}
      onError={() => setFailed(true)}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", zIndex: 0 }}
    />
  );
}

function RecipeCard({
  recipe,
  saved,
  onToggleSave,
  onOpen,
}: {
  recipe: Recipe;
  saved: boolean;
  onToggleSave: (id: string) => void;
  onOpen?: () => void;
}) {
  return (
    <div className="recipe" style={{ cursor: "pointer" }} onClick={onOpen}>
      <div className="rc-img" style={{ background: recipe.g }}>
        {recipe.image && <RecipeImage src={recipe.image} alt={recipe.t} />}
        <span className="rc-diet" style={{ zIndex: 1 }}>{recipe.mine ? "Mine" : DIET_LABEL[recipe.diets[0]]}</span>
        {!recipe.mine && (
          <span
            className={`rc-save${saved ? " on" : ""}`}
            style={{ zIndex: 1 }}
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
  const { open: openInApp } = useWebViewer();
  const [diet, setDiet] = useState<Diet>(() => {
    if (typeof window === "undefined") return "high-protein";
    const stored = localStorage.getItem(DIET_KEY) as Diet | null;
    return stored && DIETS.includes(stored) ? stored : "high-protein";
  });
  const [savedIds, setSavedIds] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try { return JSON.parse(localStorage.getItem(SAVED_KEY) ?? "null") ?? []; }
    catch { return []; }
  });
  const [myRecipes, setMyRecipes] = useState<Recipe[]>(() => {
    if (typeof window === "undefined") return [];
    try { return JSON.parse(localStorage.getItem(RECIPES_KEY) ?? "null") ?? []; }
    catch { return []; }
  });
  const [storageError, setStorageError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [refreshSeed, setRefreshSeed] = useState(0);
  const titleRef = useRef<HTMLInputElement>(null);
  const timeRef = useRef<HTMLInputElement>(null);
  const kcalRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(DIET_KEY, diet);
      setStorageError(null);
    } catch {
      setStorageError("Supper Club could not save your diet preference in this browser.");
    }
  }, [diet]);

  useEffect(() => {
    try {
      localStorage.setItem(SAVED_KEY, JSON.stringify(savedIds));
      setStorageError(null);
    } catch {
      setStorageError("Supper Club could not save recipe stars in this browser.");
    }
  }, [savedIds]);

  useEffect(() => {
    try {
      localStorage.setItem(RECIPES_KEY, JSON.stringify(myRecipes));
      setStorageError(null);
    } catch {
      setStorageError("Supper Club could not save your recipes in this browser.");
    }
  }, [myRecipes]);

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
        note: noteRef.current?.value || undefined,
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
      <div className="module-status module-status-lab" style={{ marginBottom: 14 }}>
        <div>
          <div className="module-status-kicker">Lab persistence</div>
          <strong>Supper Club is local-only in this lab phase.</strong>
          <p>Diet preference, saved recipes, and added recipes are stored in this browser and are not synced to Supabase yet.</p>
        </div>
        <span>Suggested recipes are curated seed content; saved recipes only appear after you star or add them.</span>
      </div>
      {storageError && (
        <div className="module-status module-status-lab" style={{ marginBottom: 14 }}>
          <div>
            <div className="module-status-kicker">Storage unavailable</div>
            <strong>Your latest Supper Club change may not persist.</strong>
            <p>{storageError}</p>
          </div>
          <span>Check browser storage permissions, then retry the action.</span>
        </div>
      )}
        <div className="selectbox" onClick={cycleDiet}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M12 3v18M5 8c0 4 3 5 7 5M19 8c0 4-3 5-7 5" />
          </svg>
          <span>Curate: {DIET_LABEL[diet]}</span>
        <div className="savebtn" onClick={() => setRefreshSeed((s) => s + 1)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 4v4h-4" />
          </svg>
          Refresh Sources
        </div>
      </div>
      <div className="divider" />
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
            <RecipeCard key={r.id} recipe={r} saved={savedIds.includes(r.id)} onToggleSave={toggleSave} onOpen={() => openInApp(recipeUrl(r), r.t)} />
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
          <RecipeCard key={r.id} recipe={r} saved={savedIds.includes(r.id)} onToggleSave={toggleSave} onOpen={() => openInApp(recipeUrl(r), r.t)} />
        ))}
      </div>
    </>
  );
}
