export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    {
      ok: true,
      service: "jarvis",
      revision:
        process.env.VERCEL_GIT_COMMIT_SHA ??
        process.env.RELEASE_SHA ??
        "development",
    },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    },
  );
}
