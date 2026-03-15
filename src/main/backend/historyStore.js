'use strict';

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

let historyPath = null;

function getHistoryPath() {
  if (historyPath) return historyPath;
  const userData = app.getPath('userData');
  historyPath = path.join(userData, 'conversion-history.json');
  return historyPath;
}

function loadHistory() {
  try {
    const raw = fs.readFileSync(getHistoryPath(), 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return [];
  }
}

function saveHistory(history) {
  try {
    fs.writeFileSync(getHistoryPath(), JSON.stringify(history, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save history:', err.message);
  }
}

function addEntry(entry) {
  const history = loadHistory();
  history.unshift({ ...entry, id: Date.now() });
  // Keep last 100 entries
  if (history.length > 100) history.splice(100);
  saveHistory(history);
}

function clearHistory() {
  saveHistory([]);
}

module.exports = { loadHistory, addEntry, clearHistory };
