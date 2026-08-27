import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";
import { build } from "esbuild";

const here = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = resolve(here, "../..");
const rawPort = Number(process.env.PLAYWRIGHT_TRIP_FIXTURE_PORT ?? "4179");
const port = Number.isInteger(rawPort) && rawPort >= 1024 && rawPort <= 65535 ? rawPort : 4179;
const execFileAsync = promisify(execFile);

const contentTypes: Record<string, string> = {
  "/": "text/html; charset=utf-8",
  "/fixture.js": "text/javascript; charset=utf-8",
  "/fixture.css": "text/css; charset=utf-8",
  "/artifact": "text/html; charset=utf-8",
  "/artifact.js": "text/javascript; charset=utf-8",
  "/private-video": "text/html; charset=utf-8",
  "/private-video.js": "text/javascript; charset=utf-8",
  "/private-pdf": "text/html; charset=utf-8",
  "/private-pdf.js": "text/javascript; charset=utf-8",
  "/voice": "text/html; charset=utf-8",
  "/voice-child": "text/html; charset=utf-8",
  "/voice.js": "text/javascript; charset=utf-8",
  "/caption": "text/html; charset=utf-8",
  "/caption.js": "text/javascript; charset=utf-8",
  "/caption.css": "text/css; charset=utf-8",
  "/work-map": "text/html; charset=utf-8",
  "/work-map.js": "text/javascript; charset=utf-8",
  "/work-map.css": "text/css; charset=utf-8",
  "/location": "text/html; charset=utf-8",
  "/location.js": "text/javascript; charset=utf-8",
  "/booking-marker": "text/html; charset=utf-8",
  "/booking-marker.js": "text/javascript; charset=utf-8",
  "/offline-map": "text/html; charset=utf-8",
  "/offline-map.js": "text/javascript; charset=utf-8",
  "/city-itinerary": "text/html; charset=utf-8",
  "/city-itinerary.js": "text/javascript; charset=utf-8",
};

const csp = [
  "default-src 'self'",
  "base-uri 'none'",
  // Fixtures never need a remote connection. The work-map fixture does fetch
  // its same-origin summary endpoint so its interactive component stays real.
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'none'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
].join("; ");

const fixtureHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Trip timeline fixture</title>
    <link rel="stylesheet" href="/fixture.css" />
  </head>
  <body>
    <div id="root"></div>
    <script src="/fixture.js" defer></script>
  </body>
</html>`;

const artifactFixtureHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Artifact card fixture</title>
  </head>
  <body>
    <div id="root"></div>
    <script src="/artifact.js" defer></script>
  </body>
</html>`;

const privateVideoFixtureHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Private video player fixture</title>
  </head>
  <body>
    <div id="root"></div>
    <script src="/private-video.js" defer></script>
  </body>
</html>`;

const privatePdfFixtureHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Private PDF viewer fixture</title>
  </head>
  <body>
    <div id="root"></div>
    <script src="/private-pdf.js" defer></script>
  </body>
</html>`;

const fixtureArtifactBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>\n', "utf8");
const fixturePdfBytes = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n", "utf8");
// A deterministic 160×90 one-second H.264 MP4 is generated in the fixture
// temp directory so the browser test exercises a real metadata load.
let fixtureVideoBytes: Buffer;

const voiceFixtureHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Browser voice lease fixture</title>
  </head>
  <body>
    <main aria-label="Browser voice lease fixture">
      <h1>Browser voice lease fixture</h1>
      <iframe title="Main Jarvis" src="/voice-child?frame=main"></iframe>
      <iframe title="Overlay Jarvis" src="/voice-child?frame=overlay"></iframe>
    </main>
  </body>
</html>`;

const voiceChildHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script src="/voice.js" defer></script>
  </body>
</html>`;

const captionFixtureHtml = [
  "<!doctype html>",
  "<html lang=\"en\">",
  "  <head>",
  "    <meta charset=\"utf-8\" />",
  "    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />",
  "    <title>Spoken caption layout fixture</title>",
  "    <link rel=\"stylesheet\" href=\"/caption.css\" />",
  "  </head>",
  "  <body>",
  "    <div id=\"root\"></div>",
  "    <script src=\"/caption.js\" defer></script>",
  "  </body>",
  "</html>",
].join("\n");

const workMapFixtureHtml = [
  "<!doctype html>",
  "<html lang=\"en\">",
  "  <head>",
  "    <meta charset=\"utf-8\" />",
  "    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />",
  "    <title>Jarvis work map fixture</title>",
  "    <link rel=\"stylesheet\" href=\"/work-map.css\" />",
  "  </head>",
  "  <body>",
  "    <div id=\"root\"></div>",
  "    <script src=\"/work-map.js\" defer></script>",
  "  </body>",
  "</html>",
].join("\n");

const locationFixtureHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Trip location follow fixture</title>
  </head>
  <body>
    <div id="root"></div>
    <script src="/location.js" defer></script>
  </body>
</html>`;

const bookingMarkerFixtureHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Booked location marker fixture</title>
  </head>
  <body>
    <div id="root"></div>
    <script src="/booking-marker.js" defer></script>
  </body>
</html>`;

const offlineMapFixtureHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Apple Maps offline preflight fixture</title>
  </head>
  <body>
    <div id="root"></div>
    <script src="/offline-map.js" defer></script>
  </body>
</html>`;

const cityItineraryFixtureHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>City-scoped itinerary fixture</title>
    <link rel="stylesheet" href="/fixture.css" />
  </head>
  <body>
    <div id="root"></div>
    <script src="/city-itinerary.js" defer></script>
  </body>
</html>`;

async function main() {
  const outputDir = await mkdtemp(join(tmpdir(), "jarvis-trip-timeline-fixture-"));
  const workMapCss = await postcss([tailwindcss()]).process(
    await readFile(join(projectRoot, "src/app/globals.css"), "utf8"),
    { from: join(projectRoot, "src/app/globals.css") },
  ).then((result) => result.css);
  const fixtureVideoPath = join(outputDir, "fixture-video.mp4");
  await execFileAsync("ffmpeg", [
    "-loglevel", "error",
    "-f", "lavfi",
    "-i", "color=c=0x174a68:s=160x90:d=1",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-y",
    fixtureVideoPath,
  ]);
  fixtureVideoBytes = await readFile(fixtureVideoPath);

  await build({
  absWorkingDir: projectRoot,
  bundle: true,
  define: { "process.env.NODE_ENV": JSON.stringify("test") },
  entryNames: "[name]",
  entryPoints: {
    fixture: join(projectRoot, "e2e/fixtures/trip-timeline.browser.tsx"),
    artifact: join(projectRoot, "e2e/fixtures/artifact-card.browser.tsx"),
    "private-video": join(projectRoot, "e2e/fixtures/private-video-player.browser.tsx"),
    "private-pdf": join(projectRoot, "e2e/fixtures/private-pdf-viewer.browser.tsx"),
    voice: join(projectRoot, "e2e/fixtures/browser-voice-lease.browser.ts"),
    caption: join(projectRoot, "e2e/fixtures/spoken-caption-layout.browser.tsx"),
    location: join(projectRoot, "e2e/fixtures/trip-location-follow.browser.tsx"),
    "booking-marker": join(projectRoot, "e2e/fixtures/trip-booked-stay-marker.browser.tsx"),
    "offline-map": join(projectRoot, "e2e/fixtures/apple-maps-offline.browser.tsx"),
    "city-itinerary": join(projectRoot, "e2e/fixtures/trip-city-itinerary-scope.browser.tsx"),
    "work-map": join(projectRoot, "e2e/fixtures/work-map-bubble.browser.tsx"),
  },
  format: "iife",
  jsx: "automatic",
  loader: { ".css": "css", ".svg": "dataurl" },
  logLevel: "warning",
  minify: false,
  outdir: outputDir,
  platform: "browser",
  sourcemap: false,
  target: ["es2020"],
  tsconfig: join(projectRoot, "tsconfig.json"),
  });

  const fixtureJsPath = join(outputDir, "fixture.js");
  const fixtureCssPath = join(outputDir, "fixture.css");
  const artifactJsPath = join(outputDir, "artifact.js");
  const privateVideoJsPath = join(outputDir, "private-video.js");
  const privatePdfJsPath = join(outputDir, "private-pdf.js");
  const voiceJsPath = join(outputDir, "voice.js");
  const captionJsPath = join(outputDir, "caption.js");
  const captionCssPath = join(outputDir, "caption.css");
  const locationJsPath = join(outputDir, "location.js");
  const bookingMarkerJsPath = join(outputDir, "booking-marker.js");
  const offlineMapJsPath = join(outputDir, "offline-map.js");
  const cityItineraryJsPath = join(outputDir, "city-itinerary.js");
  const workMapJsPath = join(outputDir, "work-map.js");
  await Promise.all([
    access(fixtureJsPath),
    access(fixtureCssPath),
    access(artifactJsPath),
    access(privateVideoJsPath),
    access(privatePdfJsPath),
    access(voiceJsPath),
    access(captionJsPath),
    access(captionCssPath),
    access(locationJsPath),
    access(bookingMarkerJsPath),
    access(offlineMapJsPath),
    access(cityItineraryJsPath),
    access(workMapJsPath),
  ]);

  const server = createServer(async (request, response) => {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname;

  if (method !== "GET" && method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD", "Content-Security-Policy": csp });
    response.end();
    return;
  }

  if (pathname === "/api/creation-download") {
    // Fixture-only bytes exercise the browser download handoff; production
    // owner authorization remains covered by the protected Next route tests.
    if (url.searchParams.get("id") !== "fixture-mindmap") {
      response.writeHead(404, { "Content-Security-Policy": csp });
      response.end();
      return;
    }
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Disposition": 'attachment; filename="seville-days-mind-map.svg"',
      "Content-Length": String(fixtureArtifactBytes.byteLength),
      "Content-Security-Policy": csp,
      "Content-Type": "image/svg+xml",
    });
    response.end(method === "HEAD" ? undefined : fixtureArtifactBytes);
    return;
  }

  if (pathname === "/api/files/fixture-video") {
    // The actual production route also checks owner authorization. This local
    // fixture only proves the native player loads its same-origin file URL.
    response.writeHead(200, {
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "Content-Length": String(fixtureVideoBytes.byteLength),
      "Content-Security-Policy": csp,
      "Content-Type": "video/mp4",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(method === "HEAD" ? undefined : fixtureVideoBytes);
    return;
  }

  if (pathname === "/api/files/fixture-pdf") {
    const download = url.searchParams.get("download") === "1";
    response.writeHead(200, {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="fixture-itinerary.pdf"`,
      "Content-Length": String(fixturePdfBytes.byteLength),
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Type": "application/pdf",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(method === "HEAD" ? undefined : fixturePdfBytes);
    return;
  }

  if (pathname === "/api/work-map/summary") {
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Security-Policy": csp,
      "Content-Type": "application/json; charset=utf-8",
    });
    response.end(method === "HEAD" ? undefined : JSON.stringify({
      ok: true,
      openTodoCount: 2,
      todos: [{ text: "Fixture to-do", tags: ["fixture"] }],
    }));
    return;
  }

  if (!(pathname in contentTypes)) {
    response.writeHead(404, { "Content-Security-Policy": csp });
    response.end();
    return;
  }

  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", csp);
  response.setHeader("Content-Type", contentTypes[pathname]);
  if (method === "HEAD") {
    response.writeHead(200);
    response.end();
    return;
  }

  if (pathname === "/") {
    response.writeHead(200);
    response.end(fixtureHtml);
    return;
  }
  if (pathname === "/artifact") {
    response.writeHead(200);
    response.end(artifactFixtureHtml);
    return;
  }
  if (pathname === "/private-video") {
    response.writeHead(200);
    response.end(privateVideoFixtureHtml);
    return;
  }
  if (pathname === "/private-pdf") {
    response.writeHead(200);
    response.end(privatePdfFixtureHtml);
    return;
  }
  if (pathname === "/voice") {
    response.writeHead(200);
    response.end(voiceFixtureHtml);
    return;
  }
  if (pathname === "/voice-child") {
    response.writeHead(200);
    response.end(voiceChildHtml);
    return;
  }
  if (pathname === "/caption") {
    response.writeHead(200);
    response.end(captionFixtureHtml);
    return;
  }
  if (pathname === "/work-map") {
    response.writeHead(200);
    response.end(workMapFixtureHtml);
    return;
  }
  if (pathname === "/work-map.css") {
    response.writeHead(200);
    response.end(workMapCss);
    return;
  }
  if (pathname === "/location") {
    response.writeHead(200);
    response.end(locationFixtureHtml);
    return;
  }
  if (pathname === "/booking-marker") {
    response.writeHead(200);
    response.end(bookingMarkerFixtureHtml);
    return;
  }
  if (pathname === "/offline-map") {
    response.writeHead(200);
    response.end(offlineMapFixtureHtml);
    return;
  }
  if (pathname === "/city-itinerary") {
    response.writeHead(200);
    response.end(cityItineraryFixtureHtml);
    return;
  }

  const assets: Record<string, string> = {
    "/fixture.js": fixtureJsPath,
    "/fixture.css": fixtureCssPath,
    "/artifact.js": artifactJsPath,
    "/private-video.js": privateVideoJsPath,
    "/private-pdf.js": privatePdfJsPath,
    "/voice.js": voiceJsPath,
    "/caption.js": captionJsPath,
    "/caption.css": captionCssPath,
    "/work-map.js": workMapJsPath,
    "/location.js": locationJsPath,
    "/booking-marker.js": bookingMarkerJsPath,
    "/offline-map.js": offlineMapJsPath,
    "/city-itinerary.js": cityItineraryJsPath,
  };
  const assetPath = assets[pathname];
  if (!assetPath) {
    response.writeHead(404, { "Content-Security-Policy": csp });
    response.end();
    return;
  }
  response.writeHead(200);
  response.end(await readFile(assetPath));
  });

  const cleanup = async () => {
    await rm(outputDir, { force: true, recursive: true });
  };

  const shutdown = (exitCode: number) => {
    server.close(() => {
      void cleanup().finally(() => process.exit(exitCode));
    });
    setTimeout(() => process.exit(exitCode), 3_000).unref();
  };

  process.once("SIGINT", () => shutdown(0));
  process.once("SIGTERM", () => shutdown(0));

  server.listen(port, "127.0.0.1", () => {
    console.log(`Trip timeline fixture listening on http://127.0.0.1:${port}`);
  });
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
