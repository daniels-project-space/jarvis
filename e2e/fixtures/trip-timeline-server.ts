import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = resolve(here, "../..");
const rawPort = Number(process.env.PLAYWRIGHT_TRIP_FIXTURE_PORT ?? "4179");
const port = Number.isInteger(rawPort) && rawPort >= 1024 && rawPort <= 65535 ? rawPort : 4179;

const contentTypes: Record<string, string> = {
  "/": "text/html; charset=utf-8",
  "/fixture.js": "text/javascript; charset=utf-8",
  "/fixture.css": "text/css; charset=utf-8",
  "/voice": "text/html; charset=utf-8",
  "/voice-child": "text/html; charset=utf-8",
  "/voice.js": "text/javascript; charset=utf-8",
  "/caption": "text/html; charset=utf-8",
  "/caption.js": "text/javascript; charset=utf-8",
  "/caption.css": "text/css; charset=utf-8",
  "/location": "text/html; charset=utf-8",
  "/location.js": "text/javascript; charset=utf-8",
};

const csp = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'none'",
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

async function main() {
  const outputDir = await mkdtemp(join(tmpdir(), "jarvis-trip-timeline-fixture-"));

  await build({
  absWorkingDir: projectRoot,
  bundle: true,
  define: { "process.env.NODE_ENV": JSON.stringify("test") },
  entryNames: "[name]",
  entryPoints: {
    fixture: join(projectRoot, "e2e/fixtures/trip-timeline.browser.tsx"),
    voice: join(projectRoot, "e2e/fixtures/browser-voice-lease.browser.ts"),
    caption: join(projectRoot, "e2e/fixtures/spoken-caption-layout.browser.tsx"),
    location: join(projectRoot, "e2e/fixtures/trip-location-follow.browser.tsx"),
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
  const voiceJsPath = join(outputDir, "voice.js");
  const captionJsPath = join(outputDir, "caption.js");
  const captionCssPath = join(outputDir, "caption.css");
  const locationJsPath = join(outputDir, "location.js");
  await Promise.all([
    access(fixtureJsPath),
    access(fixtureCssPath),
    access(voiceJsPath),
    access(captionJsPath),
    access(captionCssPath),
    access(locationJsPath),
  ]);

  const server = createServer(async (request, response) => {
  const method = request.method ?? "GET";
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;

  if (method !== "GET" && method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD", "Content-Security-Policy": csp });
    response.end();
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
  if (pathname === "/location") {
    response.writeHead(200);
    response.end(locationFixtureHtml);
    return;
  }

  response.writeHead(200);
  response.end(await readFile(
    pathname === "/fixture.js"
      ? fixtureJsPath
      : pathname === "/fixture.css"
        ? fixtureCssPath
        : pathname === "/caption.js"
          ? captionJsPath
          : pathname === "/caption.css"
            ? captionCssPath
            : pathname === "/location.js"
              ? locationJsPath
            : voiceJsPath,
  ));
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
