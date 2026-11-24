// Test de bout en bout : node test.js
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rdv-')); process.env.ADMIN_PASSWORD = 'secret';
const { server } = await import('./server.js');
await new Promise((r) => server.listen(0, r)); const base = `http://localhost:${server.address().port}`;
let cookie = '';
const call = async (m, p, body) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: body && JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; return { status: r.status, data: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() }; };

assert.equal((await call('GET', '/api/admin/state')).status, 401);
assert.equal((await call('POST', '/api/admin/login', { password: 'x' })).status, 401);
assert.equal((await call('POST', '/api/admin/login', { password: 'secret' })).status, 200);
await call('PUT', '/api/admin/settings', { teamsLink: 'https://teams.example/j', address: '1 rue Test' });
const t = Date.now() + 2 * 864e5;
const r = await call('POST', '/api/admin/slots', { modes: ['visio', 'teams'], slots: [{ start: new Date(t).toISOString(), end: new Date(t + 18e5).toISOString() }, { start: new Date(t + 9e5).toISOString(), end: new Date(t + 27e5).toISOString() }] });
assert.deepEqual(r.data, { added: 1, skipped: 1 }, 'chevauchement ignoré');
const id = (await call('GET', '/api/public')).data.slots[0].id;
assert.equal((await call('POST', '/api/book', { slotId: id, name: 'A', email: 'a@b.fr', mode: 'presentiel' })).status, 400, 'mode non proposé');
const b = await call('POST', '/api/book', { slotId: id, name: 'Alice', email: 'a@b.fr', mode: 'teams' }); assert.equal(b.status, 201);
assert.equal((await call('POST', '/api/book', { slotId: id, name: 'Bob', email: 'b@b.fr', mode: 'visio' })).status, 409, 'double réservation');
assert.equal((await call('GET', '/api/public')).data.slots.length, 0);
assert.equal((await call('GET', '/api/booking/' + b.data.token)).data.status, 'pending');
assert.equal((await call('POST', `/api/admin/slots/${id}/decide`, { action: 'accept', mode: 'teams' })).status, 200);
const v = (await call('GET', '/api/booking/' + b.data.token)).data; assert.equal(v.status, 'confirmed'); assert.equal(v.link, 'https://teams.example/j');
assert.match((await call('GET', `/api/booking/${b.data.token}.ics`)).data, /BEGIN:VEVENT/);
// refus : le créneau redevient libre, le client voit « refused »
await call('DELETE', '/api/admin/slots/' + id); // supprime
await call('POST', '/api/admin/slots', { modes: ['visio'], slots: [{ start: new Date(t).toISOString(), end: new Date(t + 18e5).toISOString() }] });
const id2 = (await call('GET', '/api/public')).data.slots[0].id;
const b2 = await call('POST', '/api/book', { slotId: id2, name: 'C', email: 'c@d.fr', mode: 'visio' });
await call('POST', `/api/admin/slots/${id2}/decide`, { action: 'refuse', message: 'indisponible' });
assert.equal((await call('GET', '/api/booking/' + b2.data.token)).data.status, 'refused');
assert.equal((await call('GET', '/api/public')).data.slots.length, 1, 'créneau rouvert');
assert.equal((await call('GET', '/../server.js')).status, 404);
console.log('✔ tous les tests passent'); server.close();
