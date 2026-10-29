#!/usr/bin/env bun
// A tiny OpenAI-compatible upstream for the local lab. It serves one model and
// counts the requests it receives, so the lab can prove that a request crossed
// exactly one overlay hop (a routing loop would show two).
//
//   PORT=9001 UPSTREAM_NAME=alpha MODELS=alpha-model bun mock-upstream.ts
const port = Number(process.env.PORT || 9001);
const name = process.env.UPSTREAM_NAME || "mock";
const models = (process.env.MODELS || "mock-model").split(",");
const counts = new Map<string, number>();

function inc(): number {
  const n = (counts.get("requests") ?? 0) + 1;
  counts.set("requests", n);
  return n;
}

Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/count") return Response.json({ requests: counts.get("requests") ?? 0, name });
    if (url.pathname === "/reset") {
      counts.clear();
      return Response.json({ ok: true });
    }
    if (url.pathname === "/v1/models") {
      return Response.json({ object: "list", data: models.map((m) => ({ id: m, object: "model", owned_by: name })) });
    }
    if (url.pathname === "/v1/chat/completions") {
      inc();
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
            ])
              c.enqueue(enc.encode(chunk));
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
    if (url.pathname === "/v1/responses") {
      inc();
      const body = (await req.json()) as { model?: string };
      return Response.json({
        id: "r1",
        object: "response",
        created_at: 1,
        model: body.model,
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: `responses from ${name}` }] }],
        usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
      });
    }
    if (url.pathname === "/v1/messages") {
      inc();
      const body = (await req.json()) as { model?: string };
      return Response.json({
        id: "m1",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: `messages from ${name}` }],
        stop_reason: "end_turn",
        usage: { input_tokens: 3, output_tokens: 4 },
      });
    }
    return new Response("not found", { status: 404 });
  },
});
console.error(`mock upstream ${name} on ${port}: ${models.join(",")}`);
