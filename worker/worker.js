const CV_HOST    = "https://web.spaggiari.eu";
const AUTH_PATH  = "/auth-p7/app/default/AuthApi4.php?a=aLoginPwd";

const SPOOF_HEADERS = {
  "User-Agent":      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  "Accept":          "application/json, text/plain, */*",
  "Accept-Language": "it-IT,it;q=0.9,en;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  "Origin":          "https://web.spaggiari.eu",
  "Referer":         "https://web.spaggiari.eu/",
  "ZID":             "1.0",
};

function corsHeaders(origin) {
  const allowed = origin || "*";
  return {
    "Access-Control-Allow-Origin":  allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-CV-Cookie",
    "Access-Control-Max-Age":       "86400",
  };
}

function jsonResponse(data, status = 200, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin),
    },
  });
}

function parseCookies(setCookieValues) {
  const out = {};
  const keep = new Set(["PHPSESSID", "webidentity", "webrole", "i18n_redirected"]);

  for (const header of setCookieValues) {
    const seg = header.split(";")[0].trim();
    const eq  = seg.indexOf("=");
    if (eq > 0) {
      const key = seg.slice(0, eq).trim();
      const val = seg.slice(eq + 1).trim();
      if (keep.has(key)) out[key] = val;
    }
  }
  return out;
}

async function handleLogin(request, origin) {
  let body;
  try {
    body = await request.text();
  } catch {
    return jsonResponse({ error: "body non valido" }, 400, origin);
  }

  const upstream = await fetch(`${CV_HOST}${AUTH_PATH}`, {
    method:  "POST",
    headers: {
      ...SPOOF_HEADERS,
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": String(body.length),
    },
    body,
    redirect: "manual",
  });

  const setCookieHeaders = upstream.headers.getAll
    ? upstream.headers.getAll("set-cookie")
    : [upstream.headers.get("set-cookie") || ""];

  const cookies = parseCookies(setCookieHeaders);

  if (!cookies.PHPSESSID) {
    const text = await upstream.text().catch(() => "");
    let errMsg = "credenziali non valide";
    try {
      const json = JSON.parse(text);
      if (json.error) errMsg = json.error;
    } catch {}
    return jsonResponse({ error: errMsg }, 401, origin);
  }

  const cookieStr = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  const whoamiRes = await fetch(`${CV_HOST}/rest/w1/misc/whoami`, {
    headers: { ...SPOOF_HEADERS, "Cookie": cookieStr },
  });

  if (!whoamiRes.ok) {
    return jsonResponse({ error: "impossibile ottenere info studente" }, 502, origin);
  }

  const whoami = await whoamiRes.json();

  return jsonResponse({ cookies, studentId: whoami.id }, 200, origin);
}

async function handleProxy(request, origin) {
  const url  = new URL(request.url);
  const path = url.searchParams.get("path");

  if (!path || !path.startsWith("/")) {
    return jsonResponse({ error: "path non valido" }, 400, origin);
  }

  const allowedPrefixes = ["/rest/w1/", "/auth-p7/"];
  if (!allowedPrefixes.some(p => path.startsWith(p))) {
    return jsonResponse({ error: "path non consentito" }, 403, origin);
  }

  const cookieStr = request.headers.get("X-CV-Cookie") || "";

  const upstream = await fetch(`${CV_HOST}${path}`, {
    method:  request.method,
    headers: {
      ...SPOOF_HEADERS,
      "Cookie": cookieStr,
    },
  });

  const body        = await upstream.arrayBuffer();
  const contentType = upstream.headers.get("content-type") || "application/json";

  return new Response(body, {
    status:  upstream.status,
    headers: {
      "Content-Type": contentType,
      ...corsHeaders(origin),
    },
  });
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "";
    const url    = new URL(request.url);
    const path   = url.pathname.replace(/\/+/g, "/").replace(/\/$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (path === "/login" && request.method === "POST") {
      return handleLogin(request, origin);
    }

    if (path === "/proxy" && request.method === "GET") {
      return handleProxy(request, origin);
    }

    return jsonResponse({ error: "not found", path }, 404, origin);
  },
};
