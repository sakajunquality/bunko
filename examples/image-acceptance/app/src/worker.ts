if (process.argv.slice(2).join() !== "--self-test") throw new Error("Expected --self-test");
console.log(JSON.stringify({ processed: 1 }));
