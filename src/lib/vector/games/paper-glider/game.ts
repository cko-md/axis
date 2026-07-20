/**
 * Paper Glider — Wave 15.10 engine-isolation skeleton.
 *
 * This module exists to prove the `vector-engine-three` chunk contract before
 * any Paper Glider gameplay is written: Three.js enters the bundle exactly
 * once, from here, through a plain `import("three")` (no `webpackChunkName`
 * magic comment — a comment and the next.config.ts cacheGroup competing for
 * one name silently cancel each other; see src/lib/vector/engine-chunks.test.ts
 * and the header comment on the cacheGroups in next.config.ts).
 *
 * The full game (deterministic flight core, procedural rooms, rings, scoring)
 * replaces the placeholder scene in the 15.10 wave. The registry entry stays
 * `planned` until that wave passes its complete-game gate — a loader on a
 * planned game is valid, exactly as Brickrise's was before its artwork — so
 * nothing here is reachable from the lobby, and this module claims no save
 * state, score, or achievement it does not have.
 */
import type {
  VectorGameCreateContext,
  VectorGameInstance,
  VectorGameModule,
  VectorRuntimeFrame,
  VectorRuntimeSettings,
  VectorSerializedSave,
} from "@/lib/vector/types";

type ThreeNamespace = typeof import("three");

const SAVE_SCHEMA_VERSION = 1;

function createGame(context: VectorGameCreateContext): VectorGameInstance {
  let three: ThreeNamespace | null = null;
  let renderer: import("three").WebGLRenderer | null = null;
  let scene: import("three").Scene | null = null;
  let camera: import("three").PerspectiveCamera | null = null;
  let glider: import("three").Mesh | null = null;

  let settings: VectorRuntimeSettings = context.settings;
  let disposed = false;
  let contextLost = false;
  let running = false;
  let unsubscribeScheduler: (() => void) | null = null;
  let resizeObserver: ResizeObserver | null = null;

  // Deterministic placeholder clock: advanced only by the runtime scheduler's
  // fixed steps, never by wall time, so the skeleton already obeys the same
  // clock discipline the real flight core will.
  let elapsedSteps = 0;

  const root = document.createElement("div");
  root.style.width = "100%";
  root.style.height = "100%";
  root.style.position = "relative";

  function viewportSize(): { width: number; height: number } {
    const rect = context.mount.getBoundingClientRect();
    return {
      width: Math.max(1, Math.floor(rect.width)),
      height: Math.max(1, Math.floor(rect.height)),
    };
  }

  function applySize(): void {
    if (!renderer || !camera) return;
    const { width, height } = viewportSize();
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  }

  function renderFrame(): void {
    if (disposed || contextLost || !renderer || !scene || !camera) return;
    renderer.render(scene, camera);
  }

  function handleFrame(frame: VectorRuntimeFrame): void {
    if (disposed || !running || !glider) return;
    // Reduced motion keeps the scene static; the placeholder's only motion is
    // decorative, so suppressing it entirely is the correct fallback.
    if (settings.resolvedMotion !== "reduced") {
      elapsedSteps += frame.steps;
      glider.rotation.y = (elapsedSteps * frame.stepMs) / 4000;
    }
    renderFrame();
  }

  const instance: VectorGameInstance = {
    async initialize() {
      context.mount.replaceChildren(root);

      // Plain import, no magic comment — see the file header.
      const loaded = await import("three");
      if (disposed) return;
      three = loaded;

      renderer = new three.WebGLRenderer({
        antialias: false,
        powerPreference: settings.lowPower ? "low-power" : "default",
      });
      renderer.setPixelRatio(settings.lowPower ? 1 : Math.min(window.devicePixelRatio || 1, 2));
      root.replaceChildren(renderer.domElement);

      scene = new three.Scene();
      scene.background = new three.Color(0x1a1712);
      camera = new three.PerspectiveCamera(60, 1, 0.1, 100);
      camera.position.set(0, 0.6, 3);
      camera.lookAt(0, 0, 0);

      // A single untextured triangle fold: the smallest honest stand-in for a
      // paper glider, kept until the 15.10 wave ships the real art and rooms.
      const geometry = new three.BufferGeometry();
      geometry.setAttribute(
        "position",
        new three.Float32BufferAttribute(
          [0, 0, 1, -0.8, 0.1, -1, 0, 0.15, -0.6, 0, 0.15, -0.6, 0.8, 0.1, -1, 0, 0, 1],
          3,
        ),
      );
      geometry.computeVertexNormals();
      const material = new three.MeshBasicMaterial({ color: 0xe8e2d4, side: three.DoubleSide });
      glider = new three.Mesh(geometry, material);
      scene.add(glider);

      applySize();
      resizeObserver = new ResizeObserver(() => {
        applySize();
        renderFrame();
      });
      resizeObserver.observe(context.mount);
      renderFrame();
    },

    hydrate() {
      // No persistent state exists yet; the skeleton accepts any prior save
      // (including null) without inventing state to restore.
    },

    start() {
      if (disposed) return;
      running = true;
      unsubscribeScheduler ??= context.scheduler.subscribe(handleFrame);
    },

    pause() {
      running = false;
    },

    resume() {
      if (disposed) return;
      running = true;
    },

    serialize(): VectorSerializedSave {
      // Honest empty save: schema is versioned from day one so the real game's
      // migrators have a floor to migrate from, but no fabricated progress.
      return { schemaVersion: SAVE_SCHEMA_VERSION, data: {} };
    },

    reset() {
      elapsedSteps = 0;
      if (glider) glider.rotation.set(0, 0, 0);
      renderFrame();
    },

    updateSettings(next: VectorRuntimeSettings) {
      settings = next;
      renderFrame();
    },

    handleContextLoss() {
      contextLost = true;
    },

    handleContextRestore() {
      contextLost = false;
      renderFrame();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      running = false;
      unsubscribeScheduler?.();
      unsubscribeScheduler = null;
      resizeObserver?.disconnect();
      resizeObserver = null;
      if (glider) {
        glider.geometry.dispose();
        const material = glider.material;
        for (const entry of Array.isArray(material) ? material : [material]) entry.dispose();
        glider = null;
      }
      scene = null;
      camera = null;
      renderer?.dispose();
      renderer = null;
      three = null;
      root.remove();
    },
  };

  return instance;
}

const paperGliderModule: VectorGameModule = {
  createGame,
};

export default paperGliderModule;
