import { AwsClient } from "aws4fetch";
import { ContentAddressedCheckpointStore, type CheckpointStore } from "./cloud-workspace";
import { vaultService } from "../lib/vault-client";

const BUCKET = "jarvis";

export async function createR2CheckpointStore(): Promise<CheckpointStore> {
  const secrets = await vaultService("cloudflare");
  if (!secrets.R2_ACCESS_KEY_ID || !secrets.R2_SECRET_ACCESS_KEY || !secrets.R2_ENDPOINT) {
    throw new Error("R2 checkpoint authority is not configured");
  }
  const endpoint = secrets.R2_ENDPOINT.replace(/\/$/, "");
  const aws = new AwsClient({
    accessKeyId: secrets.R2_ACCESS_KEY_ID,
    secretAccessKey: secrets.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
  return new ContentAddressedCheckpointStore(
    async (key, value, metadata) => {
      const headers: Record<string, string> = {
        "content-type": "application/x-tar",
        "content-length": String(value.byteLength),
      };
      for (const [name, item] of Object.entries(metadata)) headers[`x-amz-meta-${name}`] = item.slice(0, 240);
      const response = await aws.fetch(`${endpoint}/${BUCKET}/${key}`, {
        method: "PUT", headers, body: value as unknown as BodyInit,
      });
      if (!response.ok) throw new Error(`R2 checkpoint write failed (${response.status})`);
    },
    async (key) => {
      const response = await aws.fetch(`${endpoint}/${BUCKET}/${key}`);
      if (!response.ok) throw new Error(`R2 checkpoint read failed (${response.status})`);
      return new Uint8Array(await response.arrayBuffer());
    },
  );
}
