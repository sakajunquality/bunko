const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  hostname: "0.0.0.0",
  fetch() {
    return new Response("Hello from bunko!\n");
  },
});

process.on("SIGTERM", () => {
  server.stop(true);
  process.exit(0);
});
