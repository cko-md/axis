import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

// OAuth/login hosts must never be proxied: routing a credential page through an
// embedded webview is the "man-in-the-middle" pattern Google explicitly forbids.
// These open in a real browser tab instead (handled client-side in WebViewer).
export const OAUTH_HOSTS = [
  'accounts.google.com',
  'login.microsoftonline.com',
  'login.live.com',
  'accounts.spotify.com',
  'appleid.apple.com',
  'www.strava.com', // strava OAuth lives at /oauth on the main host
  'github.com',
];

function isOAuthHost(host: string): boolean {
  return OAUTH_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
}

function isBlockedUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0') return true;
    if (/^10\./.test(h)) return true;
    if (/^192\.168\./.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
    if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost')) return true;
    if (h === 'metadata.google.internal' || h === '169.254.169.254') return true;
    if (isOAuthHost(h)) return true;
    return false;
  } catch { return true; }
}

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

    const ct = upstream.headers.get('content-type') ?? 'text/html';

    if (!ct.includes('text/html')) {
      const buf = await upstream.arrayBuffer();
      return new NextResponse(buf, {
        status: upstream.status,
        headers: {
          'Content-Type': ct,
          'Cache-Control': 'public, max-age=120',
        },
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
    const msg = err instanceof Error ? err.message : 'Fetch failed';
    const origin = target.origin;
    const errorHtml = `<!DOCTYPE html><html><head><base href="${origin}"></head><body style="font-family:system-ui;padding:32px;background:#0a0b0e;color:#888;"><h3 style="color:#c9a463">Could not load page</h3><p style="font-size:14px">${msg}</p><p><a href="${url}" target="_blank" style="color:#c9a463">Open in browser →</a></p></body></html>`;
    return new NextResponse(errorHtml, { headers: { 'Content-Type': 'text/html' } });
  }
}
