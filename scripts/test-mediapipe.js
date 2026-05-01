/**
 * Diagnostic: verify @mediapipe/tasks-vision initializes in this Node/Nixpacks env.
 * Run: node scripts/test-mediapipe.js
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const HAND_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

function downloadIfMissing(dest) {
  if (fs.existsSync(dest)) return Promise.resolve(dest);
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const file = fs.createWriteStream(dest);
    https
      .get(HAND_MODEL_URL, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error('HTTP ' + res.statusCode));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
      })
      .on('error', (e) => {
        try {
          fs.unlinkSync(dest);
        } catch (_) {}
        reject(e);
      });
  });
}

async function test() {
  try {
    const { FilesetResolver, HandLandmarker } = require('@mediapipe/tasks-vision');
    const wasmDir = path.join(__dirname, '..', 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
    const modelPath = path.join(__dirname, 'mediapipe-models', 'hand_landmarker.task');
    await downloadIfMissing(modelPath);

    const vision = await FilesetResolver.forVisionTasks(
      // file: URL works reliably for wasm root in Node
      'file:' + path.resolve(wasmDir) + path.sep,
    );
    const handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: modelPath,
        delegate: 'CPU',
      },
      numHands: 2,
      runningMode: 'IMAGE',
    });
    console.log('MediaPipe HandLandmarker initialized successfully');
    handLandmarker.close();
    process.exit(0);
  } catch (e) {
    console.error('MediaPipe init failed:', e.message);
    if (e.stack) console.error(e.stack.split('\n').slice(0, 8).join('\n'));
    process.exit(1);
  }
}

test();
