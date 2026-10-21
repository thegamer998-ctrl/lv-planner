'use strict';
// A database backup right now (the server also makes one every night):  npm run backup
const { backupNow } = require('../src/backup');
console.log('Saved', backupNow());
