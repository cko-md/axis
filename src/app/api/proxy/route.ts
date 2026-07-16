import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { isBlockedUrl } from '@/lib/security/ssrf';

// OAuth/login hosts must never be proxied: routing a credential page through an
// embedded webview is the "man-in-the-middle" pattern Google explicitly forbids.
// These open in a real browser tab instead (handled client-side in WebViewer).
// (OAuth host list + private-IP/metadata blocking lives in @/lib/security/ssrf)

const NAV_INTERCEPT = `<script>(function(){
  document.addEventListener('click',function(e){
    var a=e.target.closest('a');if(!a)return;
    var href=a.getAttribute('href');
    if(!href||href.startsWith('#')||href.startsWith('javascript:'))return;
    try{
      var abs=new URL(href,document.baseURI).href;
      if(abs.startsWith('http://')||abs.startsWith('https://')){
        e.preventDefault();e.stopPropagation();
        window.parent.postMessage({type:'proxy-navigate',url:abs},'*');
      }
    }catch(err){}
  },true);
})();</script>`;

/**
 * Tiny document served into the iframe when the upstream content cannot be
 * embedded (PDF, X-Frame-Options/CSP framebusting, or a fetch error). It posts
 * a `proxy-reader` message to the parent WebViewer, which then loads the local
 * reader extraction route. The visible text is a fallback for the brief moment before the
 * parent swaps in reader mode.
 */
function readerFallbackDoc(targetUrl: string, reason: string): string {
  const safeUrl = targetUrl.replace(/"/g, "%22").replace(/</g, "%3C");
  const safeReason = reason.replace(/</g, "&lt;");
  // The reason is also forwarded to the parent via postMessage so WebViewer can
  // show a specific "why" message (e.g. "this site blocks embedding") instead of
  // a generic one — see the `proxy-reader` handler in WebViewer.tsx.
  const reasonForParent = JSON.stringify(reason);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;font-family:system-ui;background:#0a0b0e;color:#888;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center"><p style="font-size:13px">Opening reader view…</p><p style="font-size:11px;color:#555">${safeReason}</p></div><script>(function(){try{window.parent.postMessage({type:'proxy-reader',url:"${safeUrl}",reason:${reasonForParent}},'*');}catch(e){}})();</script></body></html>`;
}

/**
 * Decide whether an upstream HTML page will refuse to embed in our iframe.
 * We strip these headers on our OWN response, but a page that sets them almost
 * always also framebusts via JS, so it's a reliable signal to use reader mode.
 */
function willBlockEmbedding(headers: Headers): boolean {
  const xfo = headers.get("x-frame-options")?.toLowerCase() ?? "";
  if (xfo.includes("deny") || xfo.includes("sameorigin")) return true;
  const csp = headers.get("content-security-policy")?.toLowerCase() ?? "";
  const fa = csp.match(/frame-ancestors([^;]*)/)?.[1] ?? "";
  if (fa && !fa.includes("*")) return true; // any restrictive frame-ancestors
  return false;
}

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse('Unauthorized', { status: 401 });

  const url = req.nextUrl.searchParams.get('url') ?? '';
  if (!url) return new NextResponse('Missing url', { status: 400 });
  if (isBlockedUrl(url)) return new NextResponse('Forbidden', { status: 403 });

  let target: URL;
  try { target = new URL(url); } catch { return new NextResponse('Invalid URL', { status: 400 }); }

  try {
    const upstream = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Cache-Control': 'no-cache',
      },
      signal: AbortSignal.timeout(12000),
      redirect: 'follow',
    });

    if (isBlockedUrl(upstream.url)) {
      return new NextResponse('Redirected to a forbidden URL', { status: 403 });
    }

    const ct = upstream.headers.get('content-type') ?? 'text/html';

    if (!ct.includes('text/html')) {
      // Images render fine inside the iframe; pass them through untouched.
      if (ct.startsWith('image/')) {
        const buf = await upstream.arrayBuffer();
        return new NextResponse(buf, {
          status: upstream.status,
          headers: { 'Content-Type': ct, 'Cache-Control': 'public, max-age=120' },
        });
      }
      // PDFs and other binary content can't render usefully in the sandboxed
      // iframe — hand off to reader view.
      const label = ct.includes('pdf') ? 'PDF document' : 'Unsupported content type';
      return new NextResponse(readerFallbackDoc(url, label), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    // Upstream sets framebusting headers → it will refuse to embed. Switch to
    // reader mode immediately rather than wait for the client-side timeout.
    if (willBlockEmbedding(upstream.headers)) {
      return new NextResponse(readerFallbackDoc(url, 'This site blocks embedding'), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    let html = await upstream.text();
    const base = `${target.protocol}//${target.host}`;

    // Inject base tag if not present
    if (!/<base\b/i.test(html)) {
      html = html.replace(/(<head[^>]*>)/i, `$1<base href="${base}">`);
      if (!html.includes('<base ')) html = `<base href="${base}">` + html;
    }

    // Inject navigation interceptor before </body>
    html = html.includes('</body>')
      ? html.replace('</body>', NAV_INTERCEPT + '</body>')
      : html + NAV_INTERCEPT;

    return new NextResponse(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        // Deliberately omit X-Frame-Options and CSP frame-ancestors
        // so our own iframe can embed this response
      },
    });
  } catch (err) {
    // Fetch failed (timeout, DNS, TLS, upstream refusal). Hand off to reader
    // mode so the user still gets a readable fallback when possible.
    const msg = err instanceof Error ? err.message : 'Fetch failed';
    return new NextResponse(readerFallbackDoc(url, `Could not load page: ${msg}`), {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
}
