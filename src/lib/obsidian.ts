import "server-only";

// Real-time Obsidian sync: every memory JARVIS saves is committed straight to
// the git-backed vault (daniels-project-space/jarvis-memory) via the GitHub
// contents API — serverless-safe (no git binary). The 6-hourly Trigger task
// still consolidates logs/metrics on top.

const REPO = "daniels-project-space/jarvis-memory";

const FOLDER: Record<string, string> = {
  decision: "30-decisions",
  project: "20-projects",
  task: "80-facts",
  preference: "80-facts",
  fact: "80-facts",
};

const slug = (s: string) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);

export async function vaultWrite(kind: string, title: string, body: string): Promise<boolean> {
  const token = process.env.GITHUB_TOKEN;
  const s = slug(title);
  if (!token || !s) return false;
  const folder = FOLDER[kind] ?? "80-facts";
  const path = `${folder}/${s}.md`;
  const date = new Date().toISOString().slice(0, 10);
  const md = [
    `---`,
    `type: ${kind}`,
    `title: ${JSON.stringify(String(title))}`,
    `updated: ${date}`,
    `---`,
    `# ${String(title).replace(/[*#`_]/g, "")}`,
    ``,
    String(body).replace(/[*#`_]/g, "").trim(),
    ``,
    `Links: [[index]]`,
  ].join("\n");
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "content-type": "application/json",
  };
  try {
    const url = `https://api.github.com/repos/${REPO}/contents/${path}`;
    const cur = await fetch(url, { headers });
    const sha = cur.ok ? (await cur.json()).sha : undefined;
    const put = await fetch(url, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        message: `memory: ${String(title).slice(0, 60)}`,
        content: Buffer.from(md, "utf8").toString("base64"),
        ...(sha ? { sha } : {}),
      }),
    });
    return put.ok;
  } catch {
    return false;
  }
}
