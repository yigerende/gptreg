'use strict';

const { parentPort } = require('node:worker_threads');
const { saveV2State } = require('./state-store');

parentPort.on('message', ({ id, filePath, state }) => {
  try {
    parentPort.postMessage({ id, result: saveV2State(filePath, state) });
  } catch (error) {
    parentPort.postMessage({
      id,
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
        code: error.code,
        filePath: error.filePath,
        foundVersion: error.foundVersion,
        issues: error.issues,
      },
    });
  }
});
