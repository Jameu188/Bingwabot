'use strict';
const fs = require('fs');
const path = require('path');
const DB_PATH = path.join(__dirname, '..', 'db.json');

function loadDB() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    return JSON.parse(raw || '{}');
  } catch (e) {
    return {};
  }
}

function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db || {}, null, 2));
}

module.exports = { loadDB, saveDB, DB_PATH };
