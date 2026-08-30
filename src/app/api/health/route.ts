export const dynamic = "force-dynamic";

export function GET() {
  const revision = [
    process.env.RELEASE_SHA,
    process.env.VERCEL_GIT_COMMIT_SHA,
  ].find((candidate) => candidate?.trim())?.trim() ?? "development";
  return Response.json(
    {
      ok: true,
      service: "jarvis",
      revision,
    },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    },
  );
}
