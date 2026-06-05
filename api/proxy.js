const TARGET_BASE = "https://web.spaggiari.eu";

const FORWARD_REQUEST_HEADERS = ["cookie", "content-type", "content-length"];

const FORWARD_RESPONSE_HEADERS = [
  "content-type",
  "set-cookie",
  "cache-control",
  "x-spaggiari-sessionid",
];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Api-Key, Cookie"
  );

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const { path } = req.query;

  if (!path) {
    res.status(400).json({ error: "Missing ?path= parameter" });
    return;
  }

  if (!path.startsWith("/") || path.includes("..")) {
    res.status(400).json({ error: "Invalid path" });
    return;
  }

  const targetUrl = `${TARGET_BASE}${path}`;

  const forwardHeaders = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "application/json, text/html, */*",
    "Accept-Language": "it-IT,it;q=0.9",
  };

  for (const h of FORWARD_REQUEST_HEADERS) {
    if (req.headers[h]) forwardHeaders[h] = req.headers[h];
  }

  let body = undefined;
  if (["POST", "PUT", "PATCH"].includes(req.method)) {
    body = await new Promise((resolve) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
    });
  }

  let upstream;
  try {
    upstream = await fetch(targetUrl, {
      method: req.method,
      headers: forwardHeaders,
      body,
      redirect: "manual",
    });
  } catch (err) {
    console.error("[proxy] fetch error:", err);
    res.status(502).json({ error: "Upstream fetch failed", detail: err.message });
    return;
  }

  for (const h of FORWARD_RESPONSE_HEADERS) {
    const val = upstream.headers.get(h);
    if (val) res.setHeader(h, val);
  }

  if (upstream.status >= 300 && upstream.status < 400) {
    const loc = upstream.headers.get("location");
    if (loc) {
      const rewritten = loc.startsWith("https://web.spaggiari.eu")
        ? `/api/proxy?path=${encodeURIComponent(loc.replace("https://web.spaggiari.eu", ""))}`
        : loc;
      res.setHeader("Location", rewritten);
    }
  }

  res.status(upstream.status);
  const responseBody = await upstream.arrayBuffer();
  res.end(Buffer.from(responseBody));
}
