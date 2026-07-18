async function render() {
  const articleId = new URLSearchParams(location.search).get("article");
  if (!articleId) throw new Error("Missing reader article");
  const article = await window.axisReader.getArticle(articleId);
  document.title = `${article.title || "Reader"} — AXIS Reader`;
  document.querySelector("#title").textContent = article.title || "Reader";
  document.querySelector("#meta").textContent = [article.byline, article.siteName].filter(Boolean).join(" · ");
  document.querySelector("#content").innerHTML = article.html;
}

render().catch((error) => {
  document.querySelector("#title").textContent = "Reader unavailable";
  document.querySelector("#content").textContent = error instanceof Error ? error.message : "The article could not be loaded.";
});
