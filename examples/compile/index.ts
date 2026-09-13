const message = await Bun.file("data/message.txt").text();
console.log(JSON.stringify({
  message: message.trim(),
  architecture: process.arch,
  bunRevision: Bun.revision,
}));
