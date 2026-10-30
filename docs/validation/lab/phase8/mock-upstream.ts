#!/usr/bin/env bun
// A tiny OpenAI-compatible upstream for the phase-8 lab. It counts requests so
// the lab can prove that a Remote Magpie call crossed the overlay and reached
// the intended provider. No vendor, no key, no network beyond loopback.
//
//   PORT=9001 UPSTREAM_NAME=alpha MODELS=alpha-model bun mock-upstream.ts
export {};

const port = Number(process.env.PORT || 9001);
const name = process.env.UPSTREAM_NAME || "mock";
const models = (process.env.MODELS || "mock-model").split(",");
let requests = 0;

Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/count") return Response.json({ requests, name });
    if (url.pathname === "/reset") {
      requests = 0;
      return Response.json({ ok: true });
    }
    if (url.pathname === "/v1/models") {
      return Response.json({ object: "list", data: models.map((m) => ({ id: m, object: "model", owned_by: name })) });
    }
    if (url.pathname === "/v1/chat/completions") {
      requests += 1;
      const body = (await req.json()) as { model?: string; stream?: boolean };
      const text = `hello from ${name} model ${body.model}`;
      if (body.stream) {
        const enc = new TextEncoder();
        const stream = new ReadableStream({
          start(c) {
            for (const chunk of [
              `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`,
              `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
              "data: [DONE]\n\n",
            ]) c.enqueue(enc.encode(chunk));
            c.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({
        id: "c1",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
      });
    }
    return new Response("not found", { status: 404 });
  },
});
console.log(`mock upstream ${name} on 127.0.0.1:${port} (${models.join(",")})`);
