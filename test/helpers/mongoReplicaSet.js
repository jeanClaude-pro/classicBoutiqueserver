// Starts a throw-away single-node MongoDB replica set so integration tests
// exercise real multi-document transactions, write conflicts and retries.
// Never touches an existing server: random port, temporary data directory.
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { MongoClient } = require("mongodb");

function findMongod() {
  if (process.env.MONGOD_PATH && fs.existsSync(process.env.MONGOD_PATH)) return process.env.MONGOD_PATH;
  const windowsRoot = "C:\\Program Files\\MongoDB\\Server";
  if (fs.existsSync(windowsRoot)) {
    const versions = fs.readdirSync(windowsRoot).sort().reverse();
    for (const version of versions) {
      const candidate = path.join(windowsRoot, version, "bin", "mongod.exe");
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  try {
    const found = execFileSync(process.platform === "win32" ? "where" : "which", ["mongod"], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
    if (found && fs.existsSync(found)) return found;
  } catch { /* not on PATH */ }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startReplicaSet() {
  const mongod = findMongod();
  if (!mongod) return null;
  const port = await freePort();
  const dbPath = fs.mkdtempSync(path.join(os.tmpdir(), "classicboutique-rs-"));
  const child = spawn(mongod, ["--replSet", "rs0", "--port", String(port), "--bind_ip", "127.0.0.1", "--dbpath", dbPath, "--quiet"], { stdio: "ignore" });
  const directUri = `mongodb://127.0.0.1:${port}/?directConnection=true`;
  let client;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      client = await MongoClient.connect(directUri, { serverSelectionTimeoutMS: 500 });
      break;
    } catch {
      await delay(200);
    }
  }
  if (!client) throw new Error("mongod did not start");
  await client.db("admin").command({ replSetInitiate: { _id: "rs0", members: [{ _id: 0, host: `127.0.0.1:${port}` }] } });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const hello = await client.db("admin").command({ hello: 1 });
    if (hello.isWritablePrimary) break;
    await delay(200);
  }
  await client.close();
  return {
    uri: `mongodb://127.0.0.1:${port}/classicboutique_test?directConnection=true`,
    async stop() {
      try {
        const admin = await MongoClient.connect(directUri, { serverSelectionTimeoutMS: 1000 });
        await admin.db("admin").command({ shutdown: 1, force: true }).catch(() => {});
        await admin.close().catch(() => {});
      } catch { /* already stopped */ }
      child.kill();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try { fs.rmSync(dbPath, { recursive: true, force: true }); return; } catch { await delay(250); }
      }
    },
  };
}

module.exports = { startReplicaSet, findMongod };
