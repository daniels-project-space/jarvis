import { describe, expect, it } from "vitest";
import { readBoundedResponseJson, readBoundedResponseText } from "./bounded-json";

describe("bounded response decoding", () => {
  it("accepts a transparently decoded compressed response with encoded Content-Length", async () => {
    const body = JSON.stringify({ status: "success", value: [{ key: "one" }, { key: "two" }] });
    const response = new Response(body, {
      headers: {
        "content-type": "application/json",
        "content-encoding": "br",
        "content-length": "23",
      },
    });

    await expect(readBoundedResponseJson(response, 1_024)).resolves.toEqual({
      status: "success",
      value: [{ key: "one" }, { key: "two" }],
    });
  });

  it("still rejects an identity response whose declared length differs", async () => {
    const response = new Response("decoded body", {
      headers: { "content-encoding": "identity", "content-length": "3" },
    });
    await expect(readBoundedResponseText(response, 1_024)).rejects.toThrow("response length mismatch");
  });

  it("bounds decoded bytes even when the compressed transfer length is small", async () => {
    const response = new Response("decoded content is larger", {
      headers: { "content-encoding": "gzip", "content-length": "8" },
    });
    await expect(readBoundedResponseText(response, 10)).rejects.toThrow("response too large");
  });
});
