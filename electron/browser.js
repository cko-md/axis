const back = document.querySelector("#back");
const forward = document.querySelector("#forward");
const reload = document.querySelector("#reload");
const reader = document.querySelector("#reader");
const external = document.querySelector("#external");
const form = document.querySelector("#address-form");
const address = document.querySelector("#address");
const status = document.querySelector("#status");
const message = document.querySelector("#message");
let loading = false;
let messageTimer;

function showError(error) {
  clearTimeout(messageTimer);
  message.textContent = error instanceof Error ? error.message : "The browser action failed.";
  message.classList.add("visible");
  messageTimer = setTimeout(() => message.classList.remove("visible"), 5000);
}

window.axisBrowser.onState((state) => {
  address.value = state.url || "";
  back.disabled = !state.canGoBack;
  forward.disabled = !state.canGoForward;
  loading = Boolean(state.loading);
  reload.textContent = loading ? "×" : "↻";
  reload.setAttribute("aria-label", loading ? "Stop loading" : "Reload");
  status.classList.toggle("loading", loading);
  if (state.title) document.title = `${state.title} — AXIS Browser`;
  if (state.error) showError(state.error);
});

back.addEventListener("click", () => window.axisBrowser.back());
forward.addEventListener("click", () => window.axisBrowser.forward());
reload.addEventListener("click", () => loading ? window.axisBrowser.stop() : window.axisBrowser.reload());
reader.addEventListener("click", () => window.axisBrowser.reader().catch(showError));
external.addEventListener("click", () => window.axisBrowser.openExternal().catch(showError));
form.addEventListener("submit", (event) => {
  event.preventDefault();
  window.axisBrowser.navigate(address.value).catch(showError);
});
