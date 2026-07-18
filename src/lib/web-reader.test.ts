import { describe, expect, it } from "vitest";
import { extractReadableArticle } from "@/lib/web-reader";

describe("extractReadableArticle", () => {
  it("extracts article content and resolves relative URLs", async () => {
    const article = await extractReadableArticle(`
      <!doctype html><html><head><title>Axis Test</title></head><body>
        <nav>Navigation noise</nav>
        <main><article>
          <h1>A useful article</h1>
          <p>${"Readable article content ".repeat(12)}</p>
          <p><a href="/more">Read more</a></p>
        </article></main>
      </body></html>
    `, "https://example.com/story");

    expect(article?.title).toContain("Axis Test");
    expect(article?.html).toContain("Readable article content");
    expect(article?.html).toContain("https://example.com/more");
  });

  it("sanitizes scripts, event handlers, and embedded frames", async () => {
    const article = await extractReadableArticle(`
      <html><head><title>Unsafe article</title></head><body><article>
        <h1>Unsafe article</h1>
        <p>${"Enough safe content for extraction. ".repeat(10)}</p>
        <img src="https://example.com/image.jpg" onerror="steal()">
        <script>steal()</script><iframe src="https://evil.test"></iframe>
      </article></body></html>
    `, "https://example.com/unsafe");

    expect(article?.html).not.toContain("script");
    expect(article?.html).not.toContain("iframe");
    expect(article?.html).not.toContain("onerror");
  });

  it("returns null when there is no meaningful readable content", async () => {
    expect(await extractReadableArticle("<html><body><p>Short.</p></body></html>", "https://example.com")).toBeNull();
  });
});
