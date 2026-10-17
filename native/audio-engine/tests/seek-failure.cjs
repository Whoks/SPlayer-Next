/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node.js 原生集成测试 */
const assert = require("node:assert/strict");
const http = require("node:http");
const { test } = require("node:test");
const { AudioPlayer } = require(process.env.SPLAYER_AUDIO_ENGINE_MODULE || "../audio-engine.node");

/**
 * 计算 FLAC 帧校验，夹具无需外部编码器
 * @param {Buffer} bytes - 待校验的帧数据
 * @param {number} bits - 校验位数
 * @param {number} polynomial - 校验多项式
 * @returns {number} 校验值
 */
function crc(bytes, bits, polynomial) {
  let sum = 0;
  for (const byte of bytes) {
    sum ^= byte << (bits - 8);
    for (let bit = 0; bit < 8; bit++) {
      sum = (sum << 1) ^ (sum & (1 << (bits - 1)) ? polynomial : 0);
    }
    sum &= (1 << bits) - 1;
  }
  return sum;
}

test("远端 seek 回退重载失败时拒绝调用", { timeout: 30000 }, async (t) => {
  // WAV 可只更新字节位置而不读网络；FLAC 跳转必须读帧，才能覆盖回退失败分支
  const block = 4096;
  const frames = 300;
  const rate = 8000;
  const info = Buffer.alloc(42);
  info.write("fLaC");
  info[4] = 128;
  info[7] = 34;
  info.writeUInt16BE(block, 8);
  info.writeUInt16BE(block, 10);
  info.writeBigUInt64BE((BigInt(rate) << 44n) | (15n << 36n) | BigInt(frames * block), 18);
  const parts = [info];
  for (let number = 0; number < frames; number++) {
    const header = Buffer.from([
      255,
      248,
      192,
      8,
      ...(number < 128 ? [number] : [192 | (number >> 6), 128 | (number & 63)]),
    ]);
    const frame = Buffer.alloc(header.length + 1 + 1 + block * 2 + 2);
    header.copy(frame);
    frame[header.length] = crc(header, 8, 7);
    frame[header.length + 1] = 2;
    frame.writeUInt16BE(crc(frame.subarray(0, -2), 16, 0x8005), frame.length - 2);
    parts.push(frame);
  }
  const audio = Buffer.concat(parts);
  let unavailable = false;
  let failedRequests = 0;
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    if (unavailable) {
      failedRequests++;
      // 模拟远端 Range 地址失效，立即失败以免传输层退避拖慢测试
      response.writeHead(200);
      response.end("source unavailable");
      return;
    }
    const start = Number((request.headers.range || "").match(/bytes=(\d+)/)?.[1] || 0);
    response.writeHead(206, {
      "Content-Length": audio.length - start,
      "Accept-Ranges": "bytes",
      "Content-Range": "bytes " + start + "-" + (audio.length - 1) + "/" + audio.length,
    });
    response.end(audio.subarray(start));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  let player;
  t.after(async () => {
    player?.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  player = new AudioPlayer();
  await player.load("http://127.0.0.1:" + server.address().port + "/silence.flac", false);
  unavailable = true;
  await assert.rejects(player.seek(100), /\[DecodeFailed\]/);
  assert.ok(failedRequests > 0, "跳转必须实际访问失效音源");
});
