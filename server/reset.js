// Apaga o banco e recria com dados fictícios: npm run reset-db
import { resetDb, openDb } from './db.js';
resetDb();
openDb().close();
console.log('Banco recriado com dados de demonstração.');
